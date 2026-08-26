import { randomUUID } from "node:crypto";

const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;

export class FeishuMemberOnboardingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FeishuMemberOnboardingError";
    this.code = code;
  }
}

export function buildFeishuMemberOnboardingPost() {
  return {
    zh_cn: {
      title: "Feishu Codex Bridge 已为你开通",
      content: [
        [{ tag: "md", text: "Bridge Owner 已将你登记为可用成员。" }],
        [{
          tag: "md",
          text: "请等待 Bridge 完成重载，然后直接在本私聊发送 `/add`，选择或创建你个人目录中的 Codex Project/Session。",
        }],
        [{
          tag: "md",
          text: "> 你只能看到自己的 Project/Session；使用共享 Session 时，还需要加入对应的绑定群。",
        }],
      ],
    },
  };
}

export async function sendFeishuMemberOnboarding(rawClient, {
  memberOpenId,
  uuid = randomUUID(),
} = {}) {
  if (typeof rawClient?.im?.message?.create !== "function") {
    throw new TypeError("A Feishu raw client with im.message.create is required");
  }
  if (!OPEN_ID.test(String(memberOpenId || ""))) {
    throw new TypeError("A valid member open_id is required");
  }

  let response;
  try {
    response = await rawClient.im.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: memberOpenId,
        content: JSON.stringify(buildFeishuMemberOnboardingPost()),
        msg_type: "post",
        uuid,
      },
    });
  } catch {
    throw new FeishuMemberOnboardingError(
      "member_onboarding_send_failed",
      "The Bridge Bot could not send the member onboarding message",
    );
  }
  if (response?.code !== undefined && response.code !== 0) {
    throw new FeishuMemberOnboardingError(
      "member_onboarding_send_failed",
      "The Bridge Bot could not send the member onboarding message",
    );
  }
  const messageId = response?.data?.message_id || response?.data?.message?.message_id;
  if (!messageId) {
    throw new FeishuMemberOnboardingError(
      "member_onboarding_invalid_response",
      "Feishu did not return the onboarding message ID",
    );
  }
  return Object.freeze({ messageId });
}
