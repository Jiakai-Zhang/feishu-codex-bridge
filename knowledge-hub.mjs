import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const KNOWLEDGE_CATEGORIES = Object.freeze(["knowledge", "summaries", "references"]);
const CATEGORIES = new Set(KNOWLEDGE_CATEGORIES);
const ARTIFACT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const MAX_CONTENT_CHARS = 100_000;

function revision(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validateAddress(category, id) {
  if (!CATEGORIES.has(category)) throw new TypeError(`Unsupported knowledge category: ${category}`);
  if (!ARTIFACT_ID.test(id)) throw new TypeError(`Invalid knowledge artifact id: ${id}`);
}

async function exists(filePath) {
  return fs.stat(filePath).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

export class KnowledgeHub {
  constructor(rootPath, {
    projectId,
    agentId,
    repositoryIds = [],
    maxContextChars = 24_000,
    now = Date.now,
  }) {
    this.rootPath = path.resolve(rootPath);
    this.projectId = projectId;
    this.agentId = agentId;
    this.repositoryIds = [...repositoryIds];
    this.maxContextChars = maxContextChars;
    this.now = now;
    this.projectPath = path.join(this.rootPath, "projects", projectId);
  }

  paths(category, id) {
    validateAddress(category, id);
    const directory = path.join(this.projectPath, category);
    return {
      directory,
      content: path.join(directory, `${id}.md`),
      metadata: path.join(directory, `${id}.meta.json`),
      lock: path.join(directory, `${id}.lock`),
    };
  }

  async create({ category, id, title, content, authorHumanOpenId }) {
    const files = this.paths(category, id);
    const normalized = this.validateContent(content);
    const normalizedTitle = this.validateTitle(title || id);
    return this.withLock(files, async () => {
      if (await exists(files.content) || await exists(files.metadata)) throw new Error(`Knowledge artifact already exists: ${category}/${id}`);
      const timestamp = this.now();
      const metadata = {
        schemaVersion: 1,
        projectId: this.projectId,
        category,
        id,
        title: normalizedTitle,
        revision: revision(normalized),
        repositoryIds: [...this.repositoryIds],
        authorAgentId: this.agentId,
        authorHumanOpenId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.writeArtifact(files, normalized, metadata);
      return clone(metadata);
    });
  }

  async update({ category, id, content, expectedRevision, authorHumanOpenId }) {
    const files = this.paths(category, id);
    const normalized = this.validateContent(content);
    if (!/^[a-f0-9]{64}$/.test(String(expectedRevision || ""))) throw new TypeError("A full expected revision is required");
    return this.withLock(files, async () => {
      const current = await this.get(category, id);
      if (current.revision !== expectedRevision) throw new Error(`Knowledge revision conflict: expected ${expectedRevision}, current ${current.revision}`);
      const metadata = {
        ...current.metadata,
        revision: revision(normalized),
        authorAgentId: this.agentId,
        authorHumanOpenId,
        updatedAt: this.now(),
      };
      await this.writeArtifact(files, normalized, metadata);
      return clone(metadata);
    });
  }

  async get(category, id) {
    const files = this.paths(category, id);
    let content;
    let metadata;
    try {
      [content, metadata] = await Promise.all([
        fs.readFile(files.content, "utf8"),
        fs.readFile(files.metadata, "utf8").then(JSON.parse),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Unknown knowledge artifact: ${category}/${id}`);
      throw error;
    }
    if (metadata?.schemaVersion !== 1 || metadata.projectId !== this.projectId
      || metadata.category !== category || metadata.id !== id) {
      throw new Error(`Knowledge metadata mismatch: ${category}/${id}`);
    }
    const actualRevision = revision(content);
    return {
      metadata: clone(metadata),
      content,
      revision: actualRevision,
      externalChange: actualRevision !== metadata.revision,
    };
  }

  async list() {
    const records = [];
    for (const category of KNOWLEDGE_CATEGORIES) {
      const directory = path.join(this.projectPath, category);
      let entries = [];
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".meta.json")) continue;
        const id = entry.name.slice(0, -".meta.json".length);
        try {
          const artifact = await this.get(category, id);
          records.push({ ...artifact.metadata, revision: artifact.revision, externalChange: artifact.externalChange });
        } catch (error) {
          records.push({ category, id, error: error.message, updatedAt: 0 });
        }
      }
    }
    return records.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  }

  async buildContext() {
    const entries = await this.list();
    const ordered = entries.filter(({ error }) => !error).sort((left, right) => {
      const categoryOrder = KNOWLEDGE_CATEGORIES.indexOf(left.category) - KNOWLEDGE_CATEGORIES.indexOf(right.category);
      return categoryOrder || right.updatedAt - left.updatedAt;
    });
    const chunks = [
      `[共享 Team Hub；Project=${this.projectId}；Repositories=${this.repositoryIds.join(",") || "none"}]`,
      "以下是稳定知识、阶段总结和参考资料，不是实时任务状态。若与当前仓库或运行态冲突，以当前可验证事实为准。",
    ];
    for (const entry of ordered) {
      const artifact = await this.get(entry.category, entry.id);
      const header = `\n## ${entry.category}/${entry.id} · ${entry.title} · rev ${artifact.revision.slice(0, 12)}\n`;
      const remaining = this.maxContextChars - chunks.join("\n").length - header.length;
      if (remaining <= 0) break;
      chunks.push(`${header}${artifact.content.slice(0, remaining)}`);
    }
    return chunks.join("\n").slice(0, this.maxContextChars);
  }

  validateContent(content) {
    if (typeof content !== "string" || !content.trim()) throw new TypeError("Knowledge content is required");
    const normalized = content.trim();
    if (normalized.length > MAX_CONTENT_CHARS) throw new TypeError("Knowledge content is too long");
    return `${normalized}\n`;
  }

  validateTitle(title) {
    if (typeof title !== "string" || !title.trim()) throw new TypeError("Knowledge title is required");
    const normalized = title.replace(/\s+/g, " ").trim();
    if (normalized.length > 160) throw new TypeError("Knowledge title is too long");
    return normalized;
  }

  async writeArtifact(files, content, metadata) {
    const suffix = `${process.pid}-${randomUUID()}`;
    const contentTemp = `${files.content}.${suffix}.tmp`;
    const metadataTemp = `${files.metadata}.${suffix}.tmp`;
    try {
      await fs.writeFile(contentTemp, content, { encoding: "utf8", flag: "wx" });
      await fs.writeFile(metadataTemp, JSON.stringify(metadata, null, 2), { encoding: "utf8", flag: "wx" });
      await fs.rename(contentTemp, files.content);
      await fs.rename(metadataTemp, files.metadata);
    } finally {
      await fs.unlink(contentTemp).catch(() => {});
      await fs.unlink(metadataTemp).catch(() => {});
    }
  }

  async withLock(files, callback) {
    await fs.mkdir(files.directory, { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        handle = await fs.open(files.lock, "wx");
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stale = await fs.stat(files.lock).then((stat) => this.now() - stat.mtimeMs > 30_000, () => false);
        if (stale) await fs.unlink(files.lock).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!handle) throw new Error(`Knowledge artifact is locked: ${path.basename(files.content, ".md")}`);
    try { return await callback(); }
    finally {
      await handle.close().catch(() => {});
      await fs.unlink(files.lock).catch(() => {});
    }
  }
}
