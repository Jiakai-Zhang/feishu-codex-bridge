const STAGE_COPY = Object.freeze({
  preparing: { title: "正在发送视频", status: "正在生成视频封面", color: "blue", tag: "准备中" },
  cover_ready: { title: "正在发送视频", status: "封面已就绪，准备上传", color: "blue", tag: "准备中" },
  uploading: { title: "正在发送视频", status: "视频正在上传", color: "blue", tag: "上传中" },
  sending: { title: "正在发送视频", status: "上传完成，飞书正在处理", color: "blue", tag: "处理中" },
  complete: { title: "视频发送完成", status: "视频和真实画面封面已送达", color: "green", tag: "已完成" },
  failed: { title: "视频发送暂时中断", status: "网络或飞书上传中断，Bridge 会自动重试", color: "red", tag: "等待重试" },
});

function boundedPercent(uploadedBytes, totalBytes, stage) {
  if (stage === "complete" || stage === "sending") return 100;
  const uploaded = Math.max(0, Number(uploadedBytes) || 0);
  const total = Math.max(0, Number(totalBytes) || 0);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(99, Math.floor(uploaded * 100 / total)));
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatElapsed(elapsedMs) {
  const seconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function progressBar(percent) {
  const cells = 16;
  const filled = Math.round(Math.max(0, Math.min(100, percent)) * cells / 100);
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

export function buildVideoUploadProgressCard({
  stage = "preparing",
  uploadedBytes = 0,
  totalBytes = 0,
  elapsedMs = 0,
  attempt = 1,
} = {}) {
  const copy = STAGE_COPY[stage] || STAGE_COPY.preparing;
  const percent = boundedPercent(uploadedBytes, totalBytes, stage);
  const uploadedText = formatBytes(uploadedBytes);
  const totalText = formatBytes(totalBytes);
  const attemptText = Math.max(1, Number(attempt) || 1);
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "compact",
      summary: { content: `${copy.title} · ${percent}%` },
      style: {
        text_size: {
          caption: { default: "notation", pc: "notation", mobile: "notation" },
        },
      },
    },
    header: {
      title: { tag: "plain_text", content: copy.title },
      subtitle: { tag: "plain_text", content: copy.status },
      template: copy.color,
      icon: { tag: "standard_icon", token: "file-lark-minutes_colorful" },
      text_tag_list: [{
        tag: "text_tag",
        text: { tag: "plain_text", content: copy.tag },
        color: copy.color,
      }],
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "column_set",
          flex_mode: "none",
          columns: [{
            tag: "column",
            width: "weighted",
            weight: 1,
            background_style: `${copy.color}-50`,
            padding: "12px",
            vertical_spacing: "4px",
            elements: [
              {
                tag: "markdown",
                content: `## <font color='${copy.color}'>${percent}%</font>`,
                text_align: "center",
              },
              {
                tag: "markdown",
                content: `<font color='grey'>${progressBar(percent)}</font>`,
                text_align: "center",
                text_size: "caption",
              },
            ],
          }],
        },
        {
          tag: "div",
          fields: [
            {
              is_short: true,
              text: { tag: "lark_md", content: `**已上传**\n${uploadedText}` },
            },
            {
              is_short: true,
              text: { tag: "lark_md", content: `**总大小**\n${totalText}` },
            },
            {
              is_short: true,
              text: { tag: "lark_md", content: `**已用时**\n${formatElapsed(elapsedMs)}` },
            },
            {
              is_short: true,
              text: { tag: "lark_md", content: `**发送尝试**\n第 ${attemptText} 次` },
            },
          ],
        },
      ],
    },
  };
}

export function createVideoUploadProgressReporter({
  update,
  startedAt = Date.now(),
  attempt = 1,
  now = () => Date.now(),
  minIntervalMs = 1_000,
  minPercentStep = 5,
  onError,
} = {}) {
  if (typeof update !== "function") throw new TypeError("video progress reporter requires update");
  let tail = Promise.resolve();
  let lastAt = 0;
  let lastPercent = -1;
  let lastStage;

  const report = (progress = {}, { force = false } = {}) => {
    const timestamp = now();
    const stage = String(progress.stage || "preparing");
    const percent = boundedPercent(progress.uploadedBytes, progress.totalBytes, stage);
    const stageChanged = stage !== lastStage;
    if (!force && !stageChanged && timestamp - lastAt < minIntervalMs
      && percent - lastPercent < minPercentStep) {
      return tail;
    }
    lastAt = timestamp;
    lastPercent = percent;
    lastStage = stage;
    const card = buildVideoUploadProgressCard({
      ...progress,
      stage,
      attempt,
      elapsedMs: Math.max(0, timestamp - startedAt),
    });
    tail = tail.catch(() => {}).then(() => update(card)).catch((error) => {
      onError?.(error);
    });
    return tail;
  };

  return Object.freeze({
    report,
    flush: () => tail.catch(() => {}),
  });
}
