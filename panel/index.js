'use strict';

// Cocos Creator 2.4 panel for the Funplay Cocos MCP extension.
//
// The panel is intentionally thin: it renders server state exposed by the
// extension main process (main.js) over the 2.4 IPC bridge and forwards the
// Start/Stop/Restart commands back to it.

const fs = require('fs');

const EXTENSION_NAME = 'funplay-cocos-mcp';

function sendToMain(message, args, callback) {
  const payload = Array.isArray(args) ? args : [];
  Editor.Ipc.sendToMain(EXTENSION_NAME + ':' + message, ...payload, (error, result) => {
    if (error) {
      callback(error);
      return;
    }
    callback(null, result);
  });
}

function createVue(elem) {
  return new window.Vue({
    el: elem,
    data: {
      busy: false,
      message: '',
      status: {
        running: false,
        url: '',
        port: '',
        toolProfile: 'core',
        version: '',
        projectName: '',
        cocosVersion: '',
      },
      tools: [],
      recentInteractions: [],
    },
    methods: {
      applyState(state) {
        if (!state) {
          return;
        }
        if (state.status) {
          this.status = state.status;
        }
        if (Array.isArray(state.tools)) {
          this.tools = state.tools;
        }
        if (Array.isArray(state.recentInteractions)) {
          this.recentInteractions = state.recentInteractions;
        }
      },

      refresh() {
        this.busy = true;
        this.message = '';
        sendToMain('get-panel-state', [], (error, state) => {
          this.busy = false;
          if (error) {
            this.message = 'Failed to load state: ' + error.message;
            return;
          }
          this.applyState(state);
        });
      },

      runCommand(message, label) {
        this.busy = true;
        this.message = label + '...';
        sendToMain(message, [], (error, state) => {
          this.busy = false;
          if (error) {
            this.message = label + ' failed: ' + error.message;
            return;
          }
          this.message = label + ' done.';
          this.applyState({ status: state });
          this.refresh();
        });
      },

      start() {
        this.runCommand('start-server', 'Starting server');
      },

      stop() {
        this.runCommand('stop-server', 'Stopping server');
      },

      restart() {
        this.runCommand('restart-server', 'Restarting server');
      },

      copyUrl() {
        if (!this.status.url) {
          return;
        }
        const input = document.createElement('textarea');
        input.value = this.status.url;
        document.body.appendChild(input);
        input.select();
        try {
          document.execCommand('copy');
          this.message = 'Endpoint copied.';
        } catch (error) {
          this.message = 'Copy failed: ' + error.message;
        }
        document.body.removeChild(input);
      },
    },
  });
}

Editor.Panel.extend({
  template: fs.readFileSync(Editor.url('packages://' + EXTENSION_NAME + '/panel/index.html'), 'utf8'),

  style: fs.readFileSync(Editor.url('packages://' + EXTENSION_NAME + '/panel/index.css'), 'utf8'),

  messages: {
    // Pushed by the extension main process after every MCP tool call so the
    // activity list stays live without polling.
    'activity-updated'(event, state) {
      if (this._vm && state) {
        this._vm.applyState(state);
      }
    },
  },

  ready() {
    this._clientId = EXTENSION_NAME + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
    this._vm = createVue(this.shadowRoot);
    this._vm.refresh();
    Editor.Ipc.sendToMain(EXTENSION_NAME + ':panel-ready', this._clientId);
  },

  close() {
    if (this._clientId) {
      Editor.Ipc.sendToMain(EXTENSION_NAME + ':panel-closed', this._clientId);
    }
  },
});
