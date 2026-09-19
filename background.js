const COLORS = {
  music: "#1aae8f",
  speech: "#d4890a",
  silence: "#6b7280",
  off: "#4b5563",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(
    {
      enabled: true,
      speechSpeed: 1.5,
      musicSpeed: 1.0,
      silenceSpeed: 1.5,
      overlay: true,
      overlapBias: 0.1,
    },
    (vals) => chrome.storage.local.set(vals)
  );
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-enabled") return;
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  await chrome.storage.local.set({ enabled: !enabled });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "STATUS") return;
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) return;
  const on = msg.enabled !== false;
  const mode = msg.mode || "silence";
  const speed = Number(msg.speed) || 1;
  const text = !on ? "off" : speed.toFixed(1) + "x";
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: on ? COLORS[mode] || COLORS.silence : COLORS.off,
  });
});
