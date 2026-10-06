import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const DEFAULT_SIZE = 256;
const PALETTE = Object.freeze([
  [[51, 112, 255], [124, 77, 255]],
  [[0, 184, 148], [32, 119, 255]],
  [[255, 136, 0], [238, 76, 112]],
  [[45, 183, 245], [91, 79, 255]],
  [[0, 174, 114], [0, 138, 245]],
  [[173, 71, 255], [247, 71, 128]],
]);

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function mix(from, to, ratio) {
  return Math.round(from + ((to - from) * ratio));
}

function blend(target, offset, color, alpha) {
  target[offset] = mix(target[offset], color[0], alpha);
  target[offset + 1] = mix(target[offset + 1], color[1], alpha);
  target[offset + 2] = mix(target[offset + 2], color[2], alpha);
  target[offset + 3] = 255;
}

function paintCircle(pixels, size, centerX, centerY, radius, color, alpha = 1) {
  const radiusSquared = radius * radius;
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(size - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(size - 1, Math.ceil(centerY + radius));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (((x - centerX) ** 2) + ((y - centerY) ** 2) > radiusSquared) continue;
      blend(pixels, ((y * size) + x) * 4, color, alpha);
    }
  }
}

function paintRoundedRect(pixels, size, left, top, width, height, radius, color, alpha = 1) {
  const right = left + width - 1;
  const bottom = top + height - 1;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const nearestX = Math.max(left + radius, Math.min(right - radius, x));
      const nearestY = Math.max(top + radius, Math.min(bottom - radius, y));
      if (((x - nearestX) ** 2) + ((y - nearestY) ** 2) > radius * radius) continue;
      blend(pixels, ((y * size) + x) * 4, color, alpha);
    }
  }
}

function paintTriangle(pixels, size, a, b, c, color, alpha = 1) {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const edge = (p1, p2, x, y) => ((x - p1[0]) * (p2[1] - p1[1])) - ((y - p1[1]) * (p2[0] - p1[0]));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const e1 = edge(a, b, x, y);
      const e2 = edge(b, c, x, y);
      const e3 = edge(c, a, x, y);
      if (!((e1 >= 0 && e2 >= 0 && e3 >= 0) || (e1 <= 0 && e2 <= 0 && e3 <= 0))) continue;
      blend(pixels, ((y * size) + x) * 4, color, alpha);
    }
  }
}

export function createFeishuGroupAvatar(name, { size = DEFAULT_SIZE } = {}) {
  const seed = String(name || "").trim();
  if (!seed) throw new TypeError("Group avatar name is required");
  if (!Number.isInteger(size) || size < 64 || size > 512) {
    throw new TypeError("Group avatar size must be an integer between 64 and 512");
  }
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const [from, to] = PALETTE[digest[0] % PALETTE.length];
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const diagonal = (x + y) / (2 * (size - 1));
      const glow = Math.max(0, 1 - (Math.hypot(x - (size * 0.25), y - (size * 0.18)) / size));
      const offset = ((y * size) + x) * 4;
      pixels[offset] = Math.min(255, mix(from[0], to[0], diagonal) + Math.round(glow * 18));
      pixels[offset + 1] = Math.min(255, mix(from[1], to[1], diagonal) + Math.round(glow * 18));
      pixels[offset + 2] = Math.min(255, mix(from[2], to[2], diagonal) + Math.round(glow * 18));
      pixels[offset + 3] = 255;
    }
  }

  const scale = size / DEFAULT_SIZE;
  const white = [255, 255, 255];
  paintCircle(pixels, size, 208 * scale, 45 * scale, 48 * scale, white, 0.08);
  paintCircle(pixels, size, 38 * scale, 212 * scale, 64 * scale, white, 0.06);
  paintRoundedRect(
    pixels,
    size,
    Math.round(48 * scale),
    Math.round(58 * scale),
    Math.round(160 * scale),
    Math.round(120 * scale),
    Math.round(34 * scale),
    white,
    0.94,
  );
  paintTriangle(
    pixels,
    size,
    [83 * scale, 166 * scale],
    [72 * scale, 204 * scale],
    [119 * scale, 175 * scale],
    white,
    0.94,
  );
  const dotColor = [mix(from[0], to[0], 0.55), mix(from[1], to[1], 0.55), mix(from[2], to[2], 0.55)];
  const dotShift = (digest[1] % 9) - 4;
  for (const x of [92, 128, 164]) {
    paintCircle(pixels, size, (x + dotShift) * scale, 118 * scale, 10 * scale, dotColor, 0.95);
  }

  const stride = 1 + (size * 4);
  const scanlines = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    scanlines[row] = 0;
    pixels.copy(scanlines, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND"),
  ]);
}

export async function uploadFeishuGroupAvatar(client, image) {
  if (!Buffer.isBuffer(image) || image.length === 0) throw new TypeError("Group avatar image is required");
  const imageApi = client?.im?.v1?.image || client?.im?.image;
  if (!imageApi?.create) throw new Error("Feishu avatar upload client is unavailable");
  const response = await imageApi.create({
    data: { image_type: "avatar", image },
  });
  if (response?.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu avatar upload failed with code ${response.code}`);
  }
  const imageKey = response?.image_key || response?.data?.image_key;
  if (!imageKey) throw new Error("Feishu avatar upload returned no image_key");
  return String(imageKey);
}
