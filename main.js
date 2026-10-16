'use strict';

// Cocos Creator 2.4 extension entry point for the Funplay Cocos MCP server.
//
// This is the 2.4 port of the upstream browser.js (which targeted Creator 3.x).
// The embedded HTTP MCP server and stdio bridge architecture is preserved:
//   1. This main process hosts the HTTP MCP server (lib/server.js).
//   2. Scene operations are delegated to the scene process through
//      Editor.Scene.callSceneScript (see scene.js).
//   3. bin/funplay-cocos-mcp.js bridges stdio clients to the HTTP endpoint.

const path = require('path');
const os = require('os');
const fs = require('fs');
const manifest = require('./package.json');

const {
  loadConfig,
  getProjectPath,
  getProjectName,
  getProjectIdentity,
  getProjectPort,
  getCocosVersion,
} = require('./lib/config');
const { McpServer } = require('./lib/server');
const { createToolRegistry } = require('./lib/tool-registry');
const { InteractionLog } = require('./lib/interaction-log');
const { RuntimeLog } = require('./lib/runtime-log');
const { captureScriptExecution } = require('./lib/script-execution');
const { detectEditorLanguage, resolveLanguage } = require('./lib/i18n');
const editorApi = require('./lib/editor-api');

const EXTENSION_NAME = manifest.name || 'funplay-cocos-mcp';
const LOG_PREFIX = '[Funplay Cocos MCP]';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The 2.4 MVP build does not ship the resource/prompt catalogues; the MCP
// transport still requires providers, so advertise empty catalogues.
function createResourceProvider() {
  return {
    listResources: function () {
      return [];
    },
    listResourceTemplates: function () {
      return [];
    },
    readResource: async function (uri) {
      throw new Error('Resource reads are not part of the 2.4 MVP build: ' + uri);
    },
  };
}

function createPromptProvider() {
  return {
    listPrompts: function () {
      return [];
    },
    getPrompt: function (name) {
      throw new Error('Prompts are not part of the 2.4 MVP build: ' + name);
    },
  };
}

class ExtensionService {
  constructor() {
    this.config = null;
    this.server = null;
    this.toolRegistry = null;
    this.resourceProvider = null;
    this.promptProvider = null;
    this.interactionLog = new InteractionLog();
    this.runtimeLog = new RuntimeLog();
    // Panel instances registered through 'panel-ready' IPC, so activity updates
    // are only pushed while a panel is actually open.
    this.panelClients = new Set();
  }

  log(level, message, details) {
    if (this.runtimeLog && typeof this.runtimeLog.add === 'function') {
      this.runtimeLog.add(level, message, details);
    }
    if (this.config && this.config.enableConsoleLogging === false) {
      return;
    }
    const output = LOG_PREFIX + ' ' + message;
    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  load() {
    this.reloadRuntime();
    this.log('info', 'Extension loading...');
    if (this.config.autostart) {
      this.log('info', 'Autostart is enabled, starting MCP server.');
      return this.startServer();
    }
    this.log('info', 'Autostart is disabled. MCP server is idle.');
    return this.getStatus();
  }

  unload() {
    this.log('info', 'Extension unloading...');
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    this.log('info', 'Extension unloaded.');
  }

  openPanel(panelName) {
    const editor = editorApi.getEditor();
    if (!editor || !editor.Panel || typeof editor.Panel.open !== 'function') {
      throw new Error('Editor.Panel.open is unavailable in this Cocos extension host.');
    }
    const normalized = String(panelName || 'default').trim();
    const panelId = !normalized || normalized === 'default'
      ? EXTENSION_NAME
      : EXTENSION_NAME + '.' + normalized;
    editor.Panel.open(panelId);
    return { opened: true, panel: panelId };
  }

  ensureRuntime() {
    if (!this.config || !this.toolRegistry) {
      this.reloadRuntime();
    }
  }

  reloadRuntime() {
    this.config = loadConfig();
    this.interactionLog = new InteractionLog(this.config.maxInteractionLogEntries);
    this.runtimeLog = new RuntimeLog(this.config.maxInteractionLogEntries);
    this.log(
      'info',
      'Runtime config loaded: host=' + this.config.host + ', port=' + this.config.port +
        ', profile=' + this.config.toolProfile + ', autostart=' + this.config.autostart
    );

    const sceneBridge = {
      call: async function (method, payload) {
        return await editorApi.callSceneScript(method, payload || {});
      },
    };

    const runtimeContext = () => ({
      extensionName: EXTENSION_NAME,
      version: manifest.version || '0.0.0',
      config: this.config,
      projectPath: getProjectPath(),
      projectName: getProjectName(),
      projectIdentity: getProjectIdentity(),
      cocosVersion: getCocosVersion(),
      packagePath: path.dirname(__filename),
    });

    this.toolRegistry = createToolRegistry({
      getRuntimeContext: runtimeContext,
      getStatus: () => this.getStatus(),
      interactionLog: this.interactionLog,
      runtimeLog: this.runtimeLog,
      sceneBridge: sceneBridge,
      editorExecutor: async (payload) => await this.executeEditorScript(payload, runtimeContext),
      onInteraction: () => this.pushActivity(),
    });
    this.resourceProvider = createResourceProvider();
    this.promptProvider = createPromptProvider();
  }

  async startServer() {
    this.ensureRuntime();
    if (this.server && this.server.isRunning()) {
      this.log('info', 'Start requested but MCP server is already running at ' + this.getStatus().url);
      return this.getStatus();
    }

    this.log('info', 'Starting MCP server...');
    this.reloadRuntime();
    this.server = new McpServer({
      config: this.config,
      interactionLog: this.interactionLog,
      runtimeLog: this.runtimeLog,
      toolRegistry: this.toolRegistry,
      resourceProvider: this.resourceProvider,
      promptProvider: this.promptProvider,
      serverName: 'Funplay Cocos MCP - ' + getProjectName(),
      serverVersion: manifest.version || '0.0.0',
      projectName: getProjectName(),
      projectIdentity: getProjectIdentity(),
    });

    await this.server.start();
    this.log('info', 'MCP server started at ' + this.getStatus().url);
    return this.getStatus();
  }

  async stopServer() {
    this.log('info', 'Stop requested.');
    if (this.server) {
      await this.server.stop();
      this.server = null;
      this.log('info', 'MCP server stopped.');
    } else {
      this.log('info', 'Stop requested but MCP server was not running.');
    }
    return this.getStatus();
  }

  async restartServer() {
    this.log('info', 'Restart requested.');
    await this.stopServer();
    const status = await this.startServer();
    this.log('info', 'Restart completed. MCP server running=' + status.running + ', url=' + status.url);
    return status;
  }

  getEffectiveServerConnection() {
    const port = this.server && this.server.isRunning() && typeof this.server.getPort === 'function'
      ? this.server.getPort()
      : this.config.port;
    return {
      host: this.config.host,
      port: port,
      url: 'http://' + this.config.host + ':' + port + '/',
    };
  }

  getStatus() {
    this.ensureRuntime();
    const effective = this.getEffectiveServerConnection();
    const fallbackInfo = this.server && this.server.isRunning() && typeof this.server.getPortFallbackInfo === 'function'
      ? this.server.getPortFallbackInfo()
      : null;
    const attachInfo = this.server && this.server.isRunning() && typeof this.server.getAttachInfo === 'function'
      ? this.server.getAttachInfo()
      : null;
    return {
      running: Boolean(this.server && this.server.isRunning()),
      attachedToExisting: Boolean(attachInfo),
      attachInfo: attachInfo,
      host: this.config.host,
      port: effective.port,
      requestedPort: this.config.port,
      portMode: this.config.portMode,
      derivedPort: getProjectPort(),
      portFallbackActive: Boolean(fallbackInfo),
      portFallbackInfo: fallbackInfo,
      toolProfile: this.config.toolProfile,
      enableConsoleLogging: this.config.enableConsoleLogging,
      executeJavascriptSafetyChecks: this.config.executeJavascriptSafetyChecks,
      autostart: this.config.autostart,
      language: this.config.language,
      version: manifest.version || '0.0.0',
      projectPath: getProjectPath(),
      projectName: getProjectName(),
      projectIdentity: getProjectIdentity(),
      cocosVersion: getCocosVersion(),
      url: effective.url,
    };
  }

  getPanelState() {
    this.ensureRuntime();
    const status = this.getStatus();
    const tools = this.toolRegistry.listTools();
    const toolCatalog = typeof this.toolRegistry.listToolCatalog === 'function'
      ? this.toolRegistry.listToolCatalog()
      : tools;
    const detectedLanguage = detectEditorLanguage(editorApi.getEditor());
    return {
      status: status,
      tools: tools,
      toolCatalog: toolCatalog,
      recentInteractions: this.interactionLog.list(20),
      config: this.config,
      localization: {
        preference: this.config.language,
        detectedLanguage: detectedLanguage,
        resolvedLanguage: resolveLanguage(this.config.language, detectedLanguage),
      },
    };
  }

  listToolsForPanel() {
    this.ensureRuntime();
    return this.toolRegistry.listTools();
  }

  registerPanelClient(clientId) {
    if (clientId) {
      this.panelClients.add(String(clientId));
    }
    return { clients: this.panelClients.size };
  }

  unregisterPanelClient(clientId) {
    if (clientId) {
      this.panelClients.delete(String(clientId));
    }
    return { clients: this.panelClients.size };
  }

  // Push the latest activity list to any open panel after a tool call. The
  // callback is a no-op so a closed panel cannot surface IPC errors.
  pushActivity() {
    if (!this.panelClients || this.panelClients.size === 0) {
      return;
    }
    const editor = editorApi.getEditor();
    if (!editor || !editor.Ipc || typeof editor.Ipc.sendToPanel !== 'function') {
      return;
    }
    try {
      editor.Ipc.sendToPanel(EXTENSION_NAME, 'activity-updated', {
        recentInteractions: this.interactionLog.list(20),
      }, function () {});
    } catch (error) {
      // The panel may have closed between the check and the send.
    }
  }

  clearRecentActivity() {
    this.ensureRuntime();
    this.interactionLog.clear();
    return this.getPanelState();
  }

  async callToolFromPanel(name, args) {
    this.ensureRuntime();
    this.log('info', 'Panel calling tool: ' + name);
    return await this.toolRegistry.callTool(name, args || {});
  }

  async executeEditorScript(payload, runtimeContext) {
    const code = String((payload && payload.code) || '');
    if (!code.trim()) {
      throw new Error('code is required.');
    }

    const args = (payload && payload.args) ? payload.args : {};
    const context = runtimeContext();
    const service = this;
    const helpers = {
      getStatus: () => service.getStatus(),
      listTools: () => service.toolRegistry.listTools(),
      callTool: async (name, toolArgs) => await service.toolRegistry.callTool(name, toolArgs || {}),
    };

    const execute = async (scriptConsole) => {
      const runner = new AsyncFunction(
        'require',
        'Editor',
        'args',
        'context',
        'helpers',
        'fs',
        'path',
        'os',
        'console',
        [
          'const module = { exports: {} };',
          'const exports = module.exports;',
          code,
          'if (typeof run === "function") { return await run({ Editor, args, context, helpers, fs, path, os, require, console }); }',
          'if (typeof module.exports === "function") { return await module.exports({ Editor, args, context, helpers, fs, path, os, require, console }); }',
          'if (module.exports && typeof module.exports.run === "function") { return await module.exports.run({ Editor, args, context, helpers, fs, path, os, require, console }); }',
        ].join('\n')
      );
      return await runner(require, editorApi.getEditor(), args, context, helpers, fs, path, os, scriptConsole);
    };

    return payload && payload.captureActivity
      ? captureScriptExecution(execute, { context: 'editor', targetConsole: console })
      : execute(console);
  }
}

const service = new ExtensionService();

// Cocos Creator 2.4 IPC handlers receive (event, ...args) and reply through
// event.reply(err, ...results). Async results are wrapped so a thrown error is
// reported back to the caller instead of becoming an unhandled rejection.
function replyAsync(event, promise) {
  Promise.resolve(promise).then(
    function (result) {
      if (event && typeof event.reply === 'function') {
        event.reply(null, result);
      }
    },
    function (error) {
      if (event && typeof event.reply === 'function') {
        event.reply(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );
}

module.exports = {
  load() {
    return service.load();
  },

  unload() {
    return service.unload();
  },

  messages: {
    'open-panel'(event) {
      try {
        event.reply(null, service.openPanel());
      } catch (error) {
        event.reply(error instanceof Error ? error : new Error(String(error)));
      }
    },

    'start-server'(event) {
      replyAsync(event, service.startServer());
    },

    'stop-server'(event) {
      replyAsync(event, service.stopServer());
    },

    'restart-server'(event) {
      replyAsync(event, service.restartServer());
    },

    'get-status'(event) {
      try {
        event.reply(null, service.getStatus());
      } catch (error) {
        event.reply(error instanceof Error ? error : new Error(String(error)));
      }
    },

    'get-panel-state'(event) {
      try {
        event.reply(null, service.getPanelState());
      } catch (error) {
        event.reply(error instanceof Error ? error : new Error(String(error)));
      }
    },

    'list-tools'(event) {
      try {
        event.reply(null, service.listToolsForPanel());
      } catch (error) {
        event.reply(error instanceof Error ? error : new Error(String(error)));
      }
    },

    'call-tool'(event, name, args) {
      replyAsync(event, service.callToolFromPanel(name, args));
    },

    'clear-activity'(event) {
      try {
        event.reply(null, service.clearRecentActivity());
      } catch (error) {
        event.reply(error instanceof Error ? error : new Error(String(error)));
      }
    },

    'panel-ready'(event, clientId) {
      try {
        event.reply(null, service.registerPanelClient(clientId));
      } catch (error) {
        event.reply(error instanceof Error ? error : new Error(String(error)));
      }
    },

    'panel-closed'(event, clientId) {
      try {
        event.reply(null, service.unregisterPanelClient(clientId));
      } catch (error) {
        event.reply(error instanceof Error ? error : new Error(String(error)));
      }
    },
  },
};
