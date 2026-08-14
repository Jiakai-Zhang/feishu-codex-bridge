export class SessionBindingRemoveError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "SessionBindingRemoveError";
    this.code = code;
  }
}

export class SessionBindingRemover {
  constructor({ registry, feedGroupManager, getStatus, getPendingQueueCount, onWarning = () => {} }) {
    this.registry = registry;
    this.feedGroupManager = feedGroupManager;
    this.getStatus = getStatus;
    this.getPendingQueueCount = getPendingQueueCount;
    this.onWarning = onWarning;
    this.tail = Promise.resolve();
  }

  async assertIdle(threadId) {
    try {
      const queueCount = Number(await this.getPendingQueueCount?.(threadId)) || 0;
      if (queueCount > 0) {
        throw new SessionBindingRemoveError(
          "binding_delete_queued",
          "The Session still has queued prompts and cannot be safely unbound",
        );
      }
      if (!this.getStatus) return;
      const view = await this.getStatus(threadId);
      if (view?.status?.type === "active" || view?.goal?.status === "active") {
        throw new SessionBindingRemoveError(
          "binding_delete_busy",
          "The Codex task is active and cannot be safely unbound yet",
        );
      }
    } catch (error) {
      if (["binding_delete_busy", "binding_delete_queued"].includes(error?.code)) throw error;
      this.onWarning(error);
    }
  }

  remove(binding) {
    const work = async () => {
      const current = (await this.registry.list()).find(
        (item) => item.groupChatId === binding.groupChatId,
      );
      if (!current || current.threadId !== binding.threadId) {
        throw new SessionBindingRemoveError(
          "binding_changed",
          "The group binding changed before confirmation",
        );
      }

      await this.assertIdle(binding.threadId);

      if (this.feedGroupManager) {
        try {
          await this.feedGroupManager.removeChat(binding.groupChatId);
        } catch (error) {
          throw new SessionBindingRemoveError(
            "binding_tag_remove_failed",
            "The Agent Feed label could not be removed; the binding was preserved",
            { cause: error },
          );
        }
      }

      try {
        // Re-check after the asynchronous Feed API call so a turn that started
        // during label removal cannot silently lose its final delivery.
        await this.assertIdle(binding.threadId);
        const removed = await this.registry.remove(binding);
        return Object.freeze({ binding: removed, tagRemoved: Boolean(this.feedGroupManager) });
      } catch (error) {
        if (this.feedGroupManager) {
          try { await this.feedGroupManager.restoreChat(binding.groupChatId); }
          catch (restoreError) { this.onWarning(restoreError); }
        }
        if (["binding_delete_busy", "binding_delete_queued"].includes(error?.code)) throw error;
        throw new SessionBindingRemoveError(
          "binding_remove_failed",
          "The local Session binding could not be removed",
          { cause: error },
        );
      }
    };
    const running = this.tail.catch(() => {}).then(work);
    this.tail = running.catch(() => {});
    return running;
  }
}
