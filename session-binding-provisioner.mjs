import { buildSessionGroupName } from "./codex-desktop-catalog.mjs";

export class SessionBindingProvisionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "SessionBindingProvisionError";
    this.code = code;
    if (options.missingScopes) this.missingScopes = Object.freeze([...options.missingScopes]);
    if (options.binding) this.binding = Object.freeze({ ...options.binding });
  }
}

export class SessionBindingProvisioner {
  constructor({
    catalog,
    registry,
    chatManager,
    feedGroupManager,
    ownerOpenId,
    verifyGroup,
    sendWelcome,
    settingsStore,
    onWarning = () => {},
  }) {
    this.catalog = catalog;
    this.registry = registry;
    this.chatManager = chatManager;
    this.feedGroupManager = feedGroupManager;
    this.ownerOpenId = ownerOpenId;
    this.verifyGroup = verifyGroup;
    this.sendWelcome = sendWelcome;
    this.settingsStore = settingsStore;
    this.onWarning = onWarning;
    this.tail = Promise.resolve();
  }

  provision(threadId, { session: suppliedSession } = {}) {
    const work = async () => {
      const bindings = await this.registry.list();
      const existing = bindings.find((binding) => binding.threadId === threadId);
      if (existing) {
        return Object.freeze({
          alreadyBound: true,
          binding: Object.freeze({ ...existing }),
        });
      }

      let session = suppliedSession;
      if (!session) {
        const catalog = await this.catalog.load({ bindings });
        session = catalog.sessionsById.get(threadId);
      }
      if (!session || session.id !== threadId) {
        throw new SessionBindingProvisionError(
          "session_not_bindable",
          "The Codex task is unavailable or is not assigned to a local Desktop Project/independent list",
        );
      }
      const projectName = session.kind === "project" ? session.projectName : "独立";
      const groupName = buildSessionGroupName(projectName, session.title);

      await this.feedGroupManager.findOrCreateGroup();
      let chat;
      try {
        chat = await this.chatManager.createSoloGroup({ name: groupName });
      } catch (error) {
        throw new SessionBindingProvisionError(error?.code || "chat_create_failed", error?.message || "Group creation failed", {
          cause: error,
          missingScopes: error?.missingScopes,
        });
      }

      const candidateBinding = Object.freeze({
        groupChatId: chat.chatId,
        threadId,
        ownerOpenId: this.ownerOpenId,
      });
      try {
        await this.verifyGroup({ binding: candidateBinding, groupName });
      } catch (error) {
        throw new SessionBindingProvisionError(
          "created_group_verification_failed",
          "The newly created group did not pass the solo owner/Bot safety check",
          { cause: error },
        );
      }
      try {
        await this.feedGroupManager.ensureChat(chat.chatId);
      } catch (error) {
        throw new SessionBindingProvisionError(
          "created_group_tag_failed",
          "The new group was created but the agent Feed label could not be applied",
          { cause: error, missingScopes: error?.missingScopes },
        );
      }

      let initializedSettings;
      try {
        initializedSettings = await this.settingsStore?.initialize(threadId);
      } catch (error) {
        throw new SessionBindingProvisionError(
          "settings_persist_failed",
          "The new binding defaults could not be persisted locally",
          { cause: error },
        );
      }

      let binding;
      try {
        binding = await this.registry.add(candidateBinding);
      } catch (error) {
        if (error?.code === "session_already_bound") {
          return Object.freeze({ alreadyBound: true, binding: error.binding });
        }
        if (initializedSettings?.created) {
          await this.settingsStore?.remove(threadId).catch((cleanupError) => this.onWarning(cleanupError));
        }
        throw new SessionBindingProvisionError(
          "binding_persist_failed",
          "The new group was created and labeled but its task binding could not be persisted",
          { cause: error },
        );
      }

      try {
        await this.sendWelcome?.({
          chatId: chat.chatId,
          groupName,
          session,
          binding,
          settings: initializedSettings?.settings,
          feedGroupName: this.feedGroupManager.groupName,
        });
      } catch (error) {
        this.onWarning(error);
      }
      return Object.freeze({
        alreadyBound: false,
        binding,
        groupName,
        feedGroupName: this.feedGroupManager.groupName,
        session: Object.freeze({ ...session }),
        settings: initializedSettings?.settings,
      });
    };
    const running = this.tail.catch(() => {}).then(work);
    this.tail = running.catch(() => {});
    return running;
  }
}
