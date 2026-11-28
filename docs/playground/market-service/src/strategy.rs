use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

pub const MIN_WINDOW_SECONDS: u32 = 10;
pub const MAX_WINDOW_SECONDS: u32 = 300;
pub const MARKET_SPIKE_ID: &str = "market-spike";
pub const MARKET_SPIKE_NAME: &str = "异动监控策略";
const MIN_PERCENT: f64 = 2.0;
const MAX_PERCENT: f64 = 100.0;
const MIN_TURNOVER_MULTIPLE: f64 = 2.0;
const MAX_TURNOVER_MULTIPLE: f64 = 100.0;
const BASELINE_MINUTES: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ObservationRule {
    pub minutes: u32,
    pub up_percent: f64,
    pub down_percent: f64,
}

impl Default for ObservationRule {
    fn default() -> Self {
        Self {
            minutes: 15,
            up_percent: 3.0,
            down_percent: 3.0,
        }
    }
}

impl ObservationRule {
    fn signed_step(self, direction: f64) -> f64 {
        if direction < 0.0 {
            -self.down_percent
        } else {
            self.up_percent
        }
    }

    fn is_valid(self) -> bool {
        self.minutes > 0
            && [self.up_percent, self.down_percent]
                .into_iter()
                .all(|percent| percent > 0.0 && percent <= MAX_PERCENT)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub enabled: bool,
    pub notify: bool,
    pub up: Option<f64>,
    pub down: Option<f64>,
    pub seconds: u32,
    pub turnover_multiple: f64,
    #[serde(default)]
    pub observation: ObservationRule,
    #[serde(default)]
    pub continuation: ContinuationRule,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ContinuationRule {
    pub auto_trade: bool,
    pub lookback_hours: u32,
    pub max_range_percent: f64,
    pub turnover_multiple: f64,
    pub stop_loss_percent: f64,
    pub take_profit_percent: f64,
}

impl Default for ContinuationRule {
    fn default() -> Self {
        Self {
            auto_trade: false, lookback_hours: 24, max_range_percent: 5.0, turnover_multiple: 5.0,
            stop_loss_percent: 1.0, take_profit_percent: 1.0,
        }
    }
}

impl ContinuationRule {
    pub fn limit_exit_percent(self) -> f64 {
        self.take_profit_percent * 0.75
    }
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
            && self.observation.is_valid()
            && self.continuation.lookback_hours >= 1
            && (0.0..=50.0).contains(&self.continuation.max_range_percent)
            && self.continuation.turnover_multiple.is_finite()
            && self.continuation.turnover_multiple >= 1.0
            && (0.1..=20.0).contains(&self.continuation.stop_loss_percent)
            && (0.1..=50.0).contains(&self.continuation.take_profit_percent)
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
            up: Some(5.0),
            down: Some(-5.0),
            seconds: 30,
            turnover_multiple: 3.0,
            observation: ObservationRule::default(),
            continuation: ContinuationRule::default(),
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
    pub original_reference: f64,
    pub first_trigger_time: i64,
    pub interval_start: i64,
    pub target: f64,
    pub threshold: f64,
    pub sample: Sample,
    pub change: f64,
    pub observation_minutes: Option<u32>,
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
    highest_band: u32,
    volume: Volume,
    last_alert_time: i64,
}

impl Series {
    fn new(first: Move, rule: ObservationRule, volume: Volume, confirmed_at: i64) -> Self {
        let log_step = (rule.signed_step(first.threshold) / 100.0).ln_1p();
        let highest_band = reached_band(first.original_reference, first.sample.price, log_step);
        Self {
            latest: first,
            highest_band,
            volume,
            last_alert_time: confirmed_at,
        }
    }

    fn upgrade(&mut self, sample: Sample, rule: ObservationRule) -> Option<Move> {
        let reference = self.latest.original_reference;
        let threshold = rule.signed_step(self.latest.threshold);
        let log_step = (threshold / 100.0).ln_1p();
        let band = reached_band(reference, sample.price, log_step);
        if band <= self.highest_band {
            return None;
        }
        let level = self.latest.level.saturating_add(band - self.highest_band);
        let previous = reference * (log_step * f64::from(band - 1)).exp();
        let target = reference * (log_step * f64::from(band)).exp();
        let change = (sample.price - previous) / previous * 100.0;
        if level == self.latest.level || !change.is_finite() || !target.is_finite() || target <= 0.0 {
            return None;
        }
        self.highest_band = band;
        self.last_alert_time = sample.time;
        self.latest = Move {
            level,
            previous,
            target,
            threshold,
            sample,
            change,
            observation_minutes: Some(rule.minutes),
            interval_start: self.latest.sample.time + 1,
            ..self.latest
        };
        Some(self.latest)
    }
}

fn reached_band(reference: f64, price: f64, log_step: f64) -> u32 {
    if !log_step.is_finite() || log_step == 0.0 {
        return 0;
    }
    let bands = (price / reference).ln() / log_step;
    // Absorb rounding at an exact threshold before converting it to a band.
    let tolerance = (f64::EPSILON * 8.0 * (bands.abs() + 1.0 / log_step.abs())).min(0.000_001);
    (bands + tolerance).floor() as u32
}

#[derive(Debug)]
pub enum Detection {
    CheckTurnover(Move),
    Confirmed(Move, Volume),
}

#[derive(Default)]
pub struct PriceWindow {
    samples: VecDeque<Sample>,
    latest: Option<Sample>,
    pending: Option<Move>,
    series: Option<Series>,
}

fn returned_to_reference(movement: Move, price: f64) -> bool {
    if movement.threshold > 0.0 {
        price <= movement.original_reference
    } else {
        price >= movement.original_reference
    }
}

impl PriceWindow {
    pub fn observe(&mut self, sample: Sample, rule: Rule) -> Option<Detection> {
        if !sample.price.is_finite()
            || sample.price <= 0.0
            || sample.time <= self.latest().map_or(0, |last| last.time)
        {
            return None;
        }
        let previous = self.latest.replace(sample);
        if let Some(pending) = self.pending {
            if returned_to_reference(pending, sample.price) {
                self.pending = None;
                self.samples.push_back(sample);
            }
            return None;
        }
        if let Some(series) = &mut self.series {
            let elapsed = sample.time - series.last_alert_time;
            if !returned_to_reference(series.latest, sample.price)
                && elapsed < i64::from(rule.observation.minutes) * 60_000
            {
                if elapsed < 0 {
                    return None;
                }
                let next = series.upgrade(sample, rule.observation)?;
                return Some(Detection::Confirmed(next, series.volume));
            }
            self.series = None;
            self.samples.push_back(sample);
            return None;
        }

        let cutoff = sample.time - i64::from(rule.seconds) * 1_000;
        while self
            .samples
            .front()
            .is_some_and(|earliest| earliest.time < cutoff)
        {
            self.samples.pop_front();
        }
        let directions = if previous.is_some_and(|previous| sample.price < previous.price) {
            [rule.down, rule.up]
        } else {
            [rule.up, rule.down]
        };
        let first = directions.into_iter().flatten().find_map(|threshold| {
            let reference = self.samples.iter().fold(sample, |extreme, prior| {
                if (threshold > 0.0 && prior.price <= extreme.price)
                    || (threshold < 0.0 && prior.price >= extreme.price) {
                    *prior
                } else {
                    extreme
                }
            });
            first_move(reference.price, sample, threshold).map(|movement| Move {
                interval_start: reference.time, ..movement
            })
        });
        let Some(first) = first else {
            self.samples.push_back(sample);
            return None;
        };
        self.samples.clear();
        self.pending = Some(first);
        Some(Detection::CheckTurnover(first))
    }

    pub fn settle(&mut self, started_at: i64, rule: ObservationRule, confirmation: Option<(Volume, i64)>) {
        let Some(first) = self.pending.filter(|pending| pending.first_trigger_time == started_at) else {
            return;
        };
        self.pending = None;
        if let Some((volume, confirmed_at)) = confirmation {
            self.series = Some(Series::new(first, rule, volume, confirmed_at));
        } else {
            self.samples.extend(self.latest);
        }
    }

    pub fn has_pending_series(&self, started_at: i64) -> bool {
        self.pending.is_some_and(|pending| pending.first_trigger_time == started_at)
    }

    pub fn has_confirmed_series(&self) -> bool {
        self.series.is_some()
    }

    pub fn latest(&self) -> Option<Sample> {
        self.latest
    }
}

fn first_move(original_reference: f64, sample: Sample, threshold: f64) -> Option<Move> {
    let factor = 1.0 + threshold / 100.0;
    let mut level = 0;
    let mut target = original_reference;
    let mut previous = original_reference;
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
    (level > 0).then(|| Move {
        level,
        previous,
        original_reference,
        first_trigger_time: sample.time,
        interval_start: sample.time,
        target,
        threshold,
        sample,
        change: (sample.price - previous) / previous * 100.0,
        observation_minutes: None,
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
            Rule { observation: ObservationRule { minutes: 0, ..rule.observation }, ..rule },
            Rule { observation: ObservationRule { up_percent: 0.0, ..rule.observation }, ..rule },
            Rule { observation: ObservationRule { down_percent: 101.0, ..rule.observation }, ..rule },
        ] {
            assert!(!invalid.is_valid());
        }
    }

    fn sample(time: i64, price: f64) -> Sample {
        Sample { time, price }
    }

    #[test]
    fn full_interval_uses_latest_extreme_and_previous_alert_even_after_skipped_bands() {
        for (prices, threshold) in [([100.0, 100.0, 106.0, 110.0], 5.0),
            ([100.0, 100.0, 94.0, 88.0], -5.0)] {
            let mut window = PriceWindow::default();
            let rule = Rule { up: (threshold > 0.0).then_some(threshold),
                down: (threshold < 0.0).then_some(threshold), ..Rule::default() };
            window.observe(sample(1000, prices[0]), rule);
            window.observe(sample(2000, prices[1]), rule);
            let Some(Detection::CheckTurnover(first)) = window.observe(sample(3000, prices[2]), rule) else {
                panic!("expected first alert");
            };
            assert_eq!(first.interval_start, 2000);
            window.settle(3000, rule.observation, Some((Volume::new(Some(10.0), Some(1.0)), 4000)));
            let Some(Detection::Confirmed(next, _)) = window.observe(sample(5000, prices[3]), rule) else {
                panic!("expected upgrade");
            };
            assert_eq!(next.interval_start, 3001);
        }
    }

    #[test]
    fn starts_observing_after_confirmation_and_ignores_earlier_upgrades() {
        let mut window = PriceWindow::default();
        let rule = Rule { down: None, ..Rule::default() };
        assert!(window.observe(sample(1_000, 100.0), rule).is_none());
        let Some(Detection::CheckTurnover(first)) =
            window.observe(sample(2_000, 106.0), rule)
        else {
            panic!("expected a turnover check");
        };
        assert_eq!(first.level, 1);
        assert!(window.observe(sample(3_000, 111.0), rule).is_none());
        assert!(window.observe(sample(2_500, 130.0), rule).is_none());
        let volume = Volume::new(Some(390_000.0), Some(120_000.0));
        assert!(!window.has_confirmed_series());
        window.settle(first.sample.time, rule.observation, Some((volume, 5_000)));
        assert_eq!(window.series.as_ref().unwrap().latest, first);
        assert!(window.observe(sample(4_999, 122.0), rule).is_none());
        assert!(window.observe(sample(99_000, 106.0899), rule).is_none());
        let Some(Detection::Confirmed(next, same_volume)) =
            window.observe(sample(100_000, 106.09), rule)
        else {
            panic!("expected the next level to keep the confirmed volume");
        };
        assert_eq!(next.level, 2);
        assert_eq!(next.first_trigger_time, first.sample.time);
        assert_eq!(next.original_reference, 100.0);
        assert_eq!(next.threshold, 3.0);
        assert!((next.previous - 103.0).abs() < 1e-10);
        assert!((next.target - 106.09).abs() < 1e-10);
        assert_eq!(next.observation_minutes, Some(15));
        assert_eq!(same_volume, volume);
    }

    #[test]
    fn compounded_observation_bands_follow_the_first_direction_until_return() {
        let volume = Volume::new(Some(6.0), Some(2.0));
        let rule = Rule {
            up: Some(3.0), down: Some(-3.0),
            observation: ObservationRule { minutes: 8, up_percent: 4.0, down_percent: 6.0 },
            ..Rule::default()
        };
        let mut window = PriceWindow::default();
        window.observe(sample(1_000, 100.0), rule);
        let Some(Detection::CheckTurnover(first)) = window.observe(sample(2_000, 103.0), rule) else {
            panic!("expected initial check");
        };
        assert_eq!(first.level, 1);
        window.settle(first.sample.time, rule.observation, Some((volume, first.sample.time)));
        assert!(window.observe(sample(3_000, 103.9), rule).is_none());
        for (time, price, level) in [(4_000, 104.0, 2), (96_000, 108.16, 3)] {
            let Some(Detection::Confirmed(upgrade, _)) = window.observe(sample(time, price), rule) else {
                panic!("expected upgrade in the same series");
            };
            assert_eq!((upgrade.level, upgrade.threshold), (level, 4.0));
            assert_eq!(upgrade.original_reference, 100.0);
            assert_eq!(upgrade.first_trigger_time, first.sample.time);
        }
        assert!(window.observe(sample(97_000, 101.0), rule).is_none());
        assert!(window.observe(sample(98_000, 108.16), rule).is_none());
        assert!(window.observe(sample(99_000, 100.0), rule).is_none());
        assert!(window.series.is_none());
        let Some(Detection::CheckTurnover(down)) = window.observe(sample(100_000, 97.0), rule) else {
            panic!("expected a new round in the opposite direction");
        };
        assert_eq!(down.threshold, -3.0);
        window.settle(down.sample.time, rule.observation, Some((volume, down.sample.time)));
        assert!(window.observe(sample(101_000, 94.01), rule).is_none());
        for (time, price, level) in [(102_000, 94.0, 2), (103_000, 88.36, 3)] {
            let Some(Detection::Confirmed(upgrade, _)) = window.observe(sample(time, price), rule) else {
                panic!("expected a downward upgrade");
            };
            assert_eq!((upgrade.level, upgrade.threshold), (level, -6.0));
            assert_eq!(upgrade.original_reference, 100.0);
        }
        assert!(window.observe(sample(104_000, 100.01), rule).is_none());
        assert!(window.series.is_none());
    }

    #[test]
    fn exited_pending_check_cannot_confirm_or_cancel_a_new_series() {
        let mut window = PriceWindow::default();
        let rule = Rule { up: None, seconds: 10, observation: ObservationRule { minutes: 1, ..ObservationRule::default() }, ..Rule::default() };
        window.observe(sample(1_000, 100.0), rule);
        let Some(Detection::CheckTurnover(old)) = window.observe(sample(2_000, 95.0), rule)
        else {
            panic!("expected initial check");
        };
        assert!(window.observe(sample(3_000, 100.1), rule).is_none());
        assert!(!window.has_pending_series(old.sample.time));
        let Some(Detection::CheckTurnover(new)) = window.observe(sample(4_000, 94.0), rule)
        else {
            panic!("expected a fresh check");
        };
        let volume = Volume::new(Some(6.0), Some(2.0));
        window.settle(old.sample.time, rule.observation, Some((volume, 4_001)));
        window.settle(old.sample.time, rule.observation, None);
        assert!(!window.has_confirmed_series());
        window.settle(new.sample.time, rule.observation, Some((volume, 4_002)));
        assert_eq!(window.series.as_ref().unwrap().latest, new);
        assert!(matches!(
            window.observe(sample(5_000, 89.0), rule),
            Some(Detection::Confirmed(_, _))
        ));
    }

    #[test]
    fn failed_turnover_allows_a_fresh_short_window_trigger() {
        let mut window = PriceWindow::default();
        let rule = Rule {
            observation: ObservationRule { minutes: 1, ..ObservationRule::default() },
            ..Rule::default()
        };
        window.observe(sample(1_000, 100.0), rule);
        assert!(matches!(window.observe(sample(2_000, 105.0), rule), Some(Detection::CheckTurnover(_))));
        assert!(window.observe(sample(3_000, 110.25), rule).is_none());
        window.settle(2_000, rule.observation, None);
        assert!(!window.has_confirmed_series());
        assert!(!window.has_pending_series(2_000));
        let volume = Volume::new(Some(6.0), Some(2.0));
        window.settle(2_000, rule.observation, Some((volume, 3_001)));
        assert!(!window.has_confirmed_series());
        let Some(Detection::CheckTurnover(next)) = window.observe(sample(4_000, 116.0), rule) else {
            panic!("expected a new check after rejection");
        };
        assert_eq!((next.level, next.original_reference), (1, 110.25));
    }

    #[test]
    fn reconnect_retains_only_confirmed_series() {
        let mut window = PriceWindow::default();
        let rule = Rule::default();
        window.observe(sample(1_000, 100.0), rule);
        assert!(!window.has_confirmed_series());
        assert!(matches!(window.observe(sample(2_000, 105.0), rule), Some(Detection::CheckTurnover(_))));
        assert!(window.has_pending_series(2_000));
        assert!(!window.has_confirmed_series());
        let volume = Volume::new(Some(6.0), Some(2.0));
        window.settle(2_000, rule.observation, Some((volume, 3_000)));
        assert!(window.has_confirmed_series());
    }

    #[test]
    fn each_upgrade_resets_the_configured_deadline() {
        let mut window = PriceWindow::default();
        let rule = Rule {
            down: None,
            observation: ObservationRule { minutes: 2, up_percent: 5.0, down_percent: 5.0 },
            ..Rule::default()
        };
        let tick = |window: &mut PriceWindow, time, price| window.observe(sample(time, price), rule);
        tick(&mut window, 1_000, 100.0);
        assert!(matches!(tick(&mut window, 2_000, 105.0), Some(Detection::CheckTurnover(_))));
        window.settle(2_000, rule.observation, Some((Volume::new(Some(6.0), Some(2.0)), 5_000)));
        assert!(matches!(tick(&mut window, 124_999, 111.0), Some(Detection::Confirmed(_, _))));
        assert!(tick(&mut window, 125_000, 112.0).is_none());
        assert!(matches!(tick(&mut window, 200_000, 115.7625), Some(Detection::Confirmed(Move { level: 3, .. }, _))));
        assert!(tick(&mut window, 319_998, 101.0).is_none());
        assert!(tick(&mut window, 319_999, 115.7625).is_none());
        assert!(window.series.is_some());
        assert!(tick(&mut window, 320_000, 121.56).is_none());
        assert!(window.series.is_none());
        let Some(Detection::CheckTurnover(new)) = tick(&mut window, 321_000, 128.0) else {
            panic!("expected a new series after the observation deadline");
        };
        assert_eq!((new.level, new.original_reference), (1, 121.56));
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
