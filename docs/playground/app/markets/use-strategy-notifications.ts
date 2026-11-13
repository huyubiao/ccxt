import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import type { StrategyNotificationEvent } from "@/lib/strategy-notification-events";
import type { NotificationConfigStatus, NotificationDelivery } from "@/lib/strategy-notifications";

type DeliveryStatus = NotificationDelivery | "invalid-event" | "forbidden" | "unavailable";
type SettingsChange = { webhook: string; secret: string } | { enabled: boolean };

const configMessages = {
  ready: "推送已启用",
  paused: "推送已暂停",
  unconfigured: "尚未配置 Webhook",
  invalid: "钉钉 Webhook 地址格式有误",
  "config-unavailable": "无法读取已保存的钉钉配置",
  checking: "正在检查钉钉推送配置…",
  unavailable: "暂时无法读取钉钉推送配置",
};

const deliveryMessages: Record<DeliveryStatus, string> = {
  sent: "钉钉已接收消息。",
  duplicate: "相同告警已提交推送。",
  paused: "钉钉推送已暂停。",
  unconfigured: "钉钉推送未配置。",
  invalid: "钉钉 Webhook 地址格式有误。",
  "config-unavailable": "无法读取已保存的钉钉配置。",
  "rate-limited": "钉钉推送达到每分钟上限，这条消息未发送。",
  failed: "钉钉推送失败，请检查 Webhook、加签密钥和服务端网络。",
  "invalid-event": "消息内容无效，请检查后重试。",
  forbidden: "当前页面没有发送这条消息的权限。",
  unavailable: "无法提交钉钉推送，请检查 Playground 服务。",
};

async function deliver(event: StrategyNotificationEvent): Promise<DeliveryStatus> {
  try {
    const response = await fetch(apiUrl("/api/strategy-notifications"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      keepalive: event.kind !== "test",
      signal: AbortSignal.timeout(15_000),
    });
    const { status } = await response.json();
    if (typeof status === "string" && Object.hasOwn(deliveryMessages, status)) return status as DeliveryStatus;
  } catch {
    // The browser monitor continues even if the notification API is unavailable.
  }
  return "unavailable";
}

export function useStrategyNotifications() {
  const [config, setConfig] = useState<NotificationConfigStatus | "checking" | "unavailable">("checking");
  const [canConfigure, setCanConfigure] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<DeliveryStatus | null>(null);
  const [alertResult, setAlertResult] = useState<DeliveryStatus | null>(null);
  const latestAlert = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    async function loadConfig() {
      try {
        const response = await fetch(apiUrl("/api/strategy-notifications"), {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (response.ok) {
          const { status, canConfigure } = await response.json();
          if (typeof status === "string" && Object.hasOwn(configMessages, status)) {
            if (!controller.signal.aborted) {
              setCanConfigure(canConfigure === true);
              setConfig(status as NotificationConfigStatus);
            }
            return;
          }
        }
      } catch {
        // Show the failure below while leaving the monitor usable.
      }
      if (!controller.signal.aborted) setConfig("unavailable");
    }
    void loadConfig();
    return () => controller.abort();
  }, []);

  const notifyStrategy = useCallback((event: Exclude<StrategyNotificationEvent, { kind: "test" }>) => {
    const sequence = ++latestAlert.current;
    void deliver(event).then((result) => {
      if (sequence === latestAlert.current) {
        setAlertResult(result === "unconfigured" || result === "paused" ? null : result);
      }
    });
  }, []);

  async function saveSettings(change: SettingsChange) {
    setSaving(true);
    setSaveMessage("");
    try {
      const response = await fetch(apiUrl("/api/strategy-notifications"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
        signal: AbortSignal.timeout(10_000),
      });
      const { status } = await response.json();
      if (response.ok && (status === "ready" || status === "paused")) {
        setConfig(status);
        setSaveMessage("已保存。");
        setTestResult(null);
        latestAlert.current++;
        setAlertResult(null);
        return true;
      }
      setSaveMessage(status === "invalid" || status === "unconfigured"
        ? "请填写从钉钉群机器人复制的完整 Webhook 地址。" : "保存失败，请检查 Playground 服务后重试。");
    } catch {
      setSaveMessage("保存失败，请检查 Playground 服务后重试。");
    } finally {
      setSaving(false);
    }
    return false;
  }

  async function testNotification(text: string) {
    setTesting(true);
    setTestResult(await deliver({ kind: "test", text: text.trim() || undefined }));
    setTesting(false);
  }

  return {
    config, configMessage: configMessages[config], canConfigure, saving, saveMessage, saveSettings,
    notifyStrategy, testing, testNotification,
    testMessage: testResult && deliveryMessages[testResult],
    alertMessage: alertResult && deliveryMessages[alertResult],
  };
}
