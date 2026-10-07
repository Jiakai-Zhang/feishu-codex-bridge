import assert from "node:assert/strict";
import test from "node:test";
import {
  createFeishuGroupAvatar,
  uploadFeishuGroupAvatar,
} from "../../../src/feishu/feishu-group-avatar.mjs";

test("builds a deterministic square PNG avatar from the group name", () => {
  const first = createFeishuGroupAvatar("Alpha/Fix login");
  const repeated = createFeishuGroupAvatar("Alpha/Fix login");
  const different = createFeishuGroupAvatar("Beta/Ship release");

  assert.equal(first.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(first.readUInt32BE(16), 256);
  assert.equal(first.readUInt32BE(20), 256);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, different);
});

test("uploads generated avatars through the Channel SDK as avatar images", async () => {
  let request;
  const image = createFeishuGroupAvatar("Alpha/Fix login", { size: 128 });
  const imageKey = await uploadFeishuGroupAvatar({
    im: {
      v1: {
        image: {
          create: async (value) => {
            request = value;
            return { code: 0, data: { image_key: "img_avatar" } };
          },
        },
      },
    },
  }, image);

  assert.equal(imageKey, "img_avatar");
  assert.equal(request.data.image_type, "avatar");
  assert.equal(request.data.image, image);
});
