import { useState, type FormEvent } from "react";
import { MAX_TEST_NOTIFICATION_LENGTH } from "@/lib/strategy-notification-events";
import type { useStrategyNotifications } from "./use-strategy-notifications";
import styles from "./markets.module.css";

export default function DingTalkSettings({
  config, configMessage, canConfigure, saving, saveMessage, saveSettings,
  testing, testNotification, testMessage, alertMessage,
}: ReturnType<typeof useStrategyNotifications>) {
  const [editing, setEditing] = useState(false);
  const configured = config === "ready" || config === "paused";
  const busy = saving || testing;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const webhook = String(fields.get("webhook") ?? "");
    const secret = String(fields.get("secret") ?? "");
    if (await saveSettings({ webhook, secret })) {
      form.reset();
      setEditing(false);
    }
  }

  function submitTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    void testNotification(String(fields.get("message") ?? ""));
  }

  return (
    <section className={`${styles.result} ${styles.monitorSettings} ${styles.notificationSettings}`} aria-labelledby="dingtalk-heading">
      <div className={styles.monitorForm}>
        <h3 id="dingtalk-heading" tabIndex={-1}>钉钉推送</h3>
        <span role="status">{configMessage}</span>
        {canConfigure && configured && !editing && <button type="button" disabled={busy} onClick={() => setEditing(true)}>更换机器人</button>}
        {canConfigure && configured && <button type="button" disabled={busy}
          onClick={() => void saveSettings({ enabled: config === "paused" })}>
          {config === "paused" ? "恢复推送" : "暂停推送"}
        </button>}
      </div>
      {canConfigure && (!configured || editing) && (
        <form className={`${styles.monitorForm} ${styles.notificationForm}`} onSubmit={(event) => void submit(event)} autoComplete="off">
          <label htmlFor="dingtalk-webhook">Webhook 地址</label>
          <input id="dingtalk-webhook" name="webhook" type="password" autoComplete="off" spellCheck={false}
            placeholder="粘贴群机器人的完整 Webhook" required maxLength={2048} disabled={busy} />
          <label htmlFor="dingtalk-secret">加签密钥</label>
          <input id="dingtalk-secret" name="secret" type="password" autoComplete="off" spellCheck={false}
            placeholder="机器人启用加签时填写" maxLength={256} disabled={busy} />
          <div className={styles.monitorForm}>
            <button type="submit" disabled={busy}>{saving ? "正在保存…" : "保存并启用"}</button>
            {editing && <button type="button" disabled={busy} onClick={() => setEditing(false)}>取消</button>}
          </div>
        </form>
      )}
      {!canConfigure && config === "unconfigured" && <p>请在运行 Playground 的电脑上用 start-playground.cmd 启动，再打开本机行情页进行配置。</p>}
      {saveMessage && <p role="status">{saveMessage}</p>}
      {config === "ready" && !editing && (
        <form className={`${styles.monitorForm} ${styles.notificationTestForm}`} onSubmit={submitTest}>
          {canConfigure && <>
            <label htmlFor="dingtalk-test-message">测试消息内容（可选）</label>
            <textarea id="dingtalk-test-message" name="message" rows={3} maxLength={MAX_TEST_NOTIFICATION_LENGTH}
              aria-describedby="dingtalk-test-help" disabled={busy} />
            <span id="dingtalk-test-help">最多 {MAX_TEST_NOTIFICATION_LENGTH} 字，留空发送默认测试消息。</span>
          </>}
          <button type="submit" disabled={busy}>{testing ? "正在发送测试消息…" : "发送测试消息"}</button>
        </form>
      )}
      {!testing && testMessage && <p role="status">测试推送：{testMessage}</p>}
      {alertMessage && <p role="status">最近一次告警推送：{alertMessage}</p>}
    </section>
  );
}
