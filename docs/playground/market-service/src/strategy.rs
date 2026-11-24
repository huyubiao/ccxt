use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

pub const MIN_WINDOW_SECONDS: u32 = 10;
pub const MAX_WINDOW_SECONDS: u32 = 300;
pub const MARKET_SPIKE_NAME: &str = "异动监控";
const MIN_PERCENT: f64 = 2.0;
const MAX_PERCENT: f64 = 100.0;
const MIN_TURNOVER_MULTIPLE: f64 = 2.0;
const MAX_TURNOVER_MULTIPLE: f64 = 100.0;
const BASELINE_MINUTES: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub enabled: bool,
    pub notify: bool,
    pub up: Option<f64>,
    pub down: Option<f64>,
    pub seconds: u32,
    pub turnover_multiple: f64,
}

impl Rule {
    pub fn is_valid(self) -> bool {
        (self.up.is_some() || self.down.is_some())
            && self.up.is_none_or(|up| (MIN_PERCENT..=MAX_PERCENT).contains(&up))
            && self
                .down
                .is_none_or(|down| (-MAX_PERCENT..=-MIN_PERCENT).contains(&down))
            && (MIN_WINDOW_SECONDS..=MAX_WINDOW_SECONDS).contains(&self.seconds)
            && (MIN_TURNOVER_MULTIPLE..=MAX_TURNOVER_MULTIPLE).contains(&self.turnover_multiple)
    }

    pub fn restore_saved(mut self) -> Self {
        self.up = self.up.map(|up| up.clamp(MIN_PERCENT, MAX_PERCENT));
        self.down = self.down.map(|down| down.clamp(-MAX_PERCENT, -MIN_PERCENT));
        self.seconds = self.seconds.max(MIN_WINDOW_SECONDS);
        self.turnover_multiple = self
            .turnover_multiple
            .clamp(MIN_TURNOVER_MULTIPLE, MAX_TURNOVER_MULTIPLE);
        self
    }
}

impl Default for Rule {
    fn default() -> Self {
        Self {
            enabled: false,
            notify: false,
            up: None,
            down: Some(-5.0),
            seconds: 30,
            turnover_multiple: 3.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub time: i64,
    pub price: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Move {
    pub level: u32,
    pub previous: f64,
    pub target: f64,
    pub sample: Sample,
    pub change: f64,
}

impl Move {
    pub fn forecast(self, latest: Option<Sample>) -> &'static str {
        let latest_price = latest.map_or(self.sample.price, |sample| sample.price);
        if latest_price > self.sample.price
            || (latest_price == self.sample.price && self.change > 0.0)
        {
            "up"
        } else {
            "down"
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Volume {
    pub turnover: Option<f64>,
    pub baseline: Option<f64>,
    pub multiple: Option<f64>,
}

impl Volume {
    pub fn new(turnover: Option<f64>, baseline: Option<f64>) -> Self {
        let multiple = turnover.zip(baseline).and_then(|(turnover, baseline)| {
            let multiple = turnover / baseline;
            (turnover >= 0.0 && baseline > 0.0 && baseline.is_finite() && multiple.is_finite())
                .then_some(multiple)
        });
        Self {
            turnover,
            baseline,
            multiple,
        }
    }
}

pub fn turnover_baseline(minutes: &[Option<f64>], seconds: u32) -> Option<f64> {
    if minutes.len() != BASELINE_MINUTES {
        return None;
    }
    let mut amounts: Vec<f64> = minutes.iter().copied().collect::<Option<_>>()?;
    if amounts
        .iter()
        .any(|amount| !amount.is_finite() || *amount < 0.0)
    {
        return None;
    }
    amounts.sort_by(f64::total_cmp);
    let middle = BASELINE_MINUTES / 2;
    let baseline =
        (amounts[middle - 1] / 2.0 + amounts[middle] / 2.0) * (f64::from(seconds) / 60.0);
    (baseline.is_finite() && baseline > 0.0).then_some(baseline)
}

#[derive(Debug)]
struct Series {
    latest: Move,
    volume: Option<Volume>,
}

#[derive(Debug)]
pub struct PendingCheck(Arc<Mutex<Series>>);

#[derive(Debug)]
pub enum Detection {
    CheckTurnover(Move, PendingCheck),
    Confirmed(Move, Volume),
}

#[derive(Default)]
pub struct PriceWindow {
    samples: VecDeque<Sample>,
    baseline: Option<Sample>,
    series: Option<Arc<Mutex<Series>>>,
}

impl PriceWindow {
    pub fn observe(&mut self, sample: Sample, threshold: f64, seconds: u32) -> Option<Detection> {
        if !sample.price.is_finite()
            || sample.price <= 0.0
            || sample.time <= self.latest().map_or(0, |last| last.time)
        {
            return None;
        }
        let cutoff = sample.time - i64::from(seconds) * 1_000;
        while self
            .samples
            .front()
            .is_some_and(|earliest| earliest.time < cutoff)
        {
            self.samples.pop_front();
        }
        if let Some(active) = &self.series {
            let mut series = active.lock().expect("price series lock poisoned");
            if series.latest.sample.time >= cutoff {
                let next =
                    crossed_level(series.latest.target, series.latest.level, sample, threshold);
                if let Some(next) = next {
                    series.latest = next;
                    self.samples.clear();
                }
                self.samples.push_back(sample);
                return next
                    .zip(series.volume)
                    .map(|(next, volume)| Detection::Confirmed(next, volume));
            }
        }
        if self.series.take().is_some()
            || self
                .baseline
                .is_some_and(|baseline| baseline.time <= cutoff)
        {
            self.baseline = None;
        }
        let reference = self.baseline.unwrap_or_else(|| {
            self.samples.iter().copied().fold(sample, |extreme, prior| {
                if (threshold < 0.0 && prior.price > extreme.price)
                    || (threshold > 0.0 && prior.price < extreme.price)
                {
                    prior
                } else {
                    extreme
                }
            })
        });
        let change = (sample.price - reference.price) / reference.price * 100.0;
        let at_threshold =
            (change - threshold).abs() <= f64::EPSILON * 100.0_f64.max(threshold.abs());
        let triggered = at_threshold
            || if threshold < 0.0 {
                change < threshold
            } else {
                change > threshold
            };
        if triggered {
            self.baseline = Some(sample);
            self.samples.clear();
        }
        self.samples.push_back(sample);
        let first = triggered
            .then(|| crossed_level(reference.price, 0, sample, threshold))
            .flatten()?;
        let series = Arc::new(Mutex::new(Series {
            latest: first,
            volume: None,
        }));
        self.series = Some(Arc::clone(&series));
        Some(Detection::CheckTurnover(first, PendingCheck(series)))
    }

    pub fn settle(&mut self, pending: PendingCheck, volume: Option<Volume>) -> Option<Move> {
        if let Some(volume) = volume {
            let mut series = pending.0.lock().expect("price series lock poisoned");
            series.volume = Some(volume);
            return Some(series.latest);
        }
        if self
            .series
            .as_ref()
            .is_some_and(|series| Arc::ptr_eq(series, &pending.0))
        {
            self.series = None;
            self.baseline = None;
        }
        None
    }

    pub fn latest(&self) -> Option<Sample> {
        self.samples.back().copied()
    }
}

fn crossed_level(start: f64, start_level: u32, sample: Sample, threshold: f64) -> Option<Move> {
    let factor = 1.0 + threshold / 100.0;
    let mut level = start_level;
    let mut target = start;
    let mut previous = start;
    loop {
        let next = target * factor;
        if !next.is_finite() || next <= 0.0 || next == target {
            break;
        }
        let at_target = (sample.price - next).abs() <= f64::EPSILON * sample.price.max(next) * 4.0;
        if !at_target
            && (if threshold > 0.0 {
                sample.price < next
            } else {
                sample.price > next
            })
        {
            break;
        }
        previous = target;
        target = next;
        level += 1;
    }
    (level != start_level).then(|| Move {
        level,
        previous,
        target,
        sample,
        change: (sample.price - previous) / previous * 100.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_validates_percentage_and_turnover_limits_inclusively() {
        let mut rule = Rule {
            up: Some(100.0),
            down: Some(-100.0),
            turnover_multiple: 2.0,
            ..Rule::default()
        };
        assert!(rule.is_valid());
        rule.turnover_multiple = 100.0;
        assert!(rule.is_valid());
        for invalid in [
            Rule { up: Some(100.01), ..rule },
            Rule { down: Some(-100.01), ..rule },
            Rule { turnover_multiple: 1.99, ..rule },
            Rule { turnover_multiple: 100.01, ..rule },
        ] {
            assert!(!invalid.is_valid());
        }
    }

    fn sample(time: i64, price: f64) -> Sample {
        Sample { time, price }
    }

    #[test]
    fn confirms_highest_level_reached_while_turnover_is_pending() {
        let mut window = PriceWindow::default();
        assert!(window.observe(sample(1_000, 100.0), 5.0, 30).is_none());
        let Some(Detection::CheckTurnover(first, check)) =
            window.observe(sample(2_000, 106.0), 5.0, 30)
        else {
            panic!("expected a turnover check");
        };
        assert_eq!(first.level, 1);
        assert!(window.observe(sample(3_000, 111.0), 5.0, 30).is_none());
        assert!(window.observe(sample(2_500, 130.0), 5.0, 30).is_none());
        let volume = Volume::new(Some(390_000.0), Some(120_000.0));
        assert_eq!(window.settle(check, Some(volume)).unwrap().level, 2);
        let Some(Detection::Confirmed(next, same_volume)) =
            window.observe(sample(4_000, 116.0), 5.0, 30)
        else {
            panic!("expected the next level to keep the confirmed volume");
        };
        assert_eq!(next.level, 3);
        assert_eq!(same_volume, volume);
    }

    #[test]
    fn expired_check_cannot_cancel_a_new_series() {
        let mut window = PriceWindow::default();
        window.observe(sample(1_000, 100.0), -5.0, 10);
        let Some(Detection::CheckTurnover(_, old)) = window.observe(sample(2_000, 95.0), -5.0, 10)
        else {
            panic!("expected initial check");
        };
        window.observe(sample(20_000, 100.0), -5.0, 10);
        let Some(Detection::CheckTurnover(_, new)) = window.observe(sample(21_000, 94.0), -5.0, 10)
        else {
            panic!("expected a fresh check");
        };
        window.settle(old, None);
        let volume = Volume::new(Some(6.0), Some(2.0));
        assert_eq!(
            window.settle(new, Some(volume)).unwrap().sample.time,
            21_000
        );
        assert!(matches!(
            window.observe(sample(22_000, 89.0), -5.0, 10),
            Some(Detection::Confirmed(_, _))
        ));
    }

    #[test]
    fn computes_a_scaled_median_and_distinguishes_zero_from_missing_turnover() {
        let mut minutes: Vec<_> = (1..=60)
            .rev()
            .map(|amount| Some(f64::from(amount)))
            .collect();
        assert_eq!(turnover_baseline(&minutes, 30), Some(15.25));
        assert_eq!(Volume::new(Some(0.0), Some(15.25)).multiple, Some(0.0));
        assert_eq!(Volume::new(None, Some(15.25)).multiple, None);
        minutes[0] = None;
        assert_eq!(turnover_baseline(&minutes, 30), None);
    }
}
