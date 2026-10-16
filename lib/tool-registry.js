'use strict';

// Cocos Creator 2.4 port of the Funplay MCP tool registry.
// Trimmed to the MVP (profile B) surface: unified JavaScript execution in the
// scene/editor contexts, scene + node + component CRUD, selection, scenes,
// assets, logs, and screenshots.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const IMAGE_DATA_URI_PREFIX = 'data:image/png;base64,';
const SCRIPT_EXECUTION_PACKET = 'funplay.script-execution.v1';

const {
  clearSelection,
  deleteAsset,
  getCurrentSelection,
  listAssets,
  openAsset,
  queryAssetInfo,
  queryAssetMeta,
  queryAssetUrl,
  selectAsset,
  selectNode,
} = require('./assets');
const { normalizeSceneTarget, loadEmptySceneTemplate, saveSceneContent } = require('./scenes');
const { resolveProjectPath, resolveProjectFilePath } = require('./path-safety');
const { clearProjectLogFiles, searchProjectLogs } = require('./logs');
const { runScriptDiagnostics } = require('./diagnostics');
const { assertJavascriptSafety } = require('./javascript-safety');
const { safeStringify } = require('./utils');
const editorApi = require('./editor-api');

const TOOL_CATEGORY_RULES = [
  ['project', /^(get_project_info|get_editor_state|get_tool_catalog)$/],
  ['logs', /log/],
  ['diagnostics', /diagnostic/],
  ['screenshots', /screenshot|capture/],
  ['assets', /asset/],
  ['selection', /selection|select_/],
  ['components', /component/],
  ['cameras', /camera/],
  ['ui', /canvas|label|button|sprite/],
  ['scene', /scene|hierarchy|node/],
  ['editor', /window/],
  ['execution', /execute_/],
];

function createSchema(properties, required) {
  const schema = { type: 'object', properties: properties };
  if (required && required.length) {
    schema.required = required;
  }
  return schema;
}

function createOutputSchema(dataSchema = {}) {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      tool: { type: 'string' },
      callId: { type: 'string' },
      timestamp: { type: 'string' },
      summary: { type: 'string' },
      data: dataSchema,
      execution: {
        type: 'object',
        properties: {
          context: { type: 'string' },
          durationMs: { type: 'number' },
          logs: { type: 'array', items: { type: 'object', properties: { level: { type: 'string' }, message: { type: 'string' } } } },
          logsOmitted: { type: 'number' },
        },
      },
      refs: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' }, path: { type: 'string' }, name: { type: 'string' } } } },
    },
    required: ['ok', 'tool', 'callId', 'timestamp', 'data'],
  };
}

function inferToolCategory(toolName) {
  for (const rule of TOOL_CATEGORY_RULES) {
    if (rule[1].test(toolName)) {
      return rule[0];
    }
  }
  return 'other';
}

function toolCategory(tool) {
  return tool.category || inferToolCategory(tool.name);
}

function inferToolAnnotations(tool) {
  const name = tool.name;
  const category = toolCategory(tool);
  const readOnly = /^(get|list|inspect|find|read|search|check|validate|exists|capture)/.test(name);
  const destructive = /(delete|remove|clear|replace|write|reset|set_|execute|run_scene|invoke|emit|simulate)/.test(name);
  const idempotent = readOnly || /^(set|select|open|pause|resume|stop|refresh)/.test(name);
  return {
    title: name.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : destructive,
    idempotentHint: idempotent,
    openWorldHint: false,
  };
}

function isToolExposed(config, tool) {
  const profile = config && config.toolProfile === 'full'
    ? 'full'
    : config && config.toolProfile === 'custom' ? 'custom' : 'core';
  const category = toolCategory(tool);
  const enabledTools = new Set(config && config.enabledTools || []);
  const disabledTools = new Set(config && config.disabledTools || []);
  const enabledCategories = new Set((config && config.enabledToolCategories || []).map((v) => String(v).toLowerCase()));
  const disabledCategories = new Set((config && config.disabledToolCategories || []).map((v) => String(v).toLowerCase()));

  let exposed = profile === 'full' || tool.profile === 'core';
  if (profile === 'custom') {
    exposed = tool.profile === 'core' || enabledTools.has(tool.name) || enabledCategories.has(category);
  } else if (enabledTools.has(tool.name) || enabledCategories.has(category)) {
    exposed = true;
  }
  if (disabledTools.has(tool.name) || disabledCategories.has(category)) {
    exposed = false;
  }
  return exposed;
}

function hashObject(value) {
  return crypto.createHash('sha256').update(safeStringify(value)).digest('hex').slice(0, 16);
}

function summarizeResult(result) {
  if (typeof result === 'string') {
    if (result.indexOf(IMAGE_DATA_URI_PREFIX) === 0) {
      return 'Image payload returned.';
    }
    return result.length > 160 ? result.slice(0, 160) + '...' : result;
  }
  if (!result || typeof result !== 'object') {
    return String(result);
  }
  if (typeof result.summary === 'string') {
    return result.summary;
  }
  for (const key of ['message', 'path', 'url', 'sceneName', 'projectName']) {
    if (typeof result[key] === 'string' && result[key]) {
      return key + ': ' + result[key];
    }
  }
  if (Number.isFinite(result.count)) {
    return 'count: ' + result.count;
  }
  return 'Structured result returned.';
}

function normalizeEnvelopeData(result) {
  if (typeof result === 'string' && result.indexOf(IMAGE_DATA_URI_PREFIX) === 0) {
    return {
      image: true,
      mimeType: 'image/png',
      byteLength: Buffer.byteLength(result.slice(IMAGE_DATA_URI_PREFIX.length), 'base64'),
    };
  }
  return result;
}

function addRef(refs, type, id, extra) {
  if (!id) {
    return;
  }
  const key = type + ':' + id;
  if (refs.some((ref) => ref.key === key)) {
    return;
  }
  refs.push(Object.assign({ key: key, type: type, id: String(id) }, extra || {}));
}

function collectRefs(value, refs, depth, seen) {
  refs = refs || [];
  depth = depth || 0;
  seen = seen || new WeakSet();
  if (!value || depth > 5) {
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs, depth + 1, seen);
    }
    return refs;
  }
  if (typeof value !== 'object') {
    return refs;
  }
  if (seen.has(value)) {
    return refs;
  }
  seen.add(value);

  const uuid = value.uuid || value.prefabUuid || value.sceneUuid || value.assetUuid;
  const pathValue = value.path || value.node || value.url;
  if (uuid) {
    addRef(refs, pathValue && String(pathValue).indexOf('db://') === 0 ? 'asset' : 'uuid', uuid, {
      path: pathValue ? String(pathValue) : undefined,
      name: value.name ? String(value.name) : undefined,
    });
  }
  if (typeof pathValue === 'string' && pathValue) {
    addRef(refs, pathValue.indexOf('db://') === 0 ? 'asset' : 'path', pathValue, {
      name: value.name ? String(value.name) : undefined,
    });
  }
  for (const item of Object.values(value)) {
    collectRefs(item, refs, depth + 1, seen);
  }
  return refs;
}

function createResultEnvelope(tool, args, result, options) {
  options = options || {};
  const data = normalizeEnvelopeData(result);
  const refs = collectRefs(data).map((ref) => {
    const copy = Object.assign({}, ref);
    delete copy.key;
    return copy;
  });
  const timestamp = new Date().toISOString();
  const summary = options.summary || summarizeResult(result);
  const callId = 'fp_' + hashObject({ tool: tool.name, args: args || {}, result: data });
  return {
    ok: options.ok !== false,
    tool: tool.name,
    callId: callId,
    timestamp: timestamp,
    summary: summary,
    data: data,
    refs: refs,
  };
}

function toOutput(value) {
  if (typeof value === 'string') {
    return value;
  }
  return safeStringify(value);
}

function useJavascriptSafetyChecks(args, runtimeContext) {
  if (args && typeof args.safety_checks === 'boolean') {
    return args.safety_checks;
  }
  if (args && typeof args.safetyChecks === 'boolean') {
    return args.safetyChecks;
  }
  const config = runtimeContext && runtimeContext.config;
  if (config && typeof config.executeJavascriptSafetyChecks === 'boolean') {
    return config.executeJavascriptSafetyChecks;
  }
  return true;
}

function assertToolJavascriptSafety(args, runtimeContext) {
  if (!useJavascriptSafetyChecks(args, runtimeContext)) {
    return;
  }
  assertJavascriptSafety(args && args.code, {
    projectPath: runtimeContext && runtimeContext.projectPath,
  });
}

function findEditorWindow() {
  let electron;
  try {
    electron = require('electron');
  } catch (error) {
    throw new Error('Electron is unavailable in this Cocos extension host.');
  }
  const BrowserWindow = electron.BrowserWindow;
  if (!BrowserWindow) {
    throw new Error('Electron BrowserWindow is unavailable.');
  }
  const windows = (BrowserWindow.getAllWindows && BrowserWindow.getAllWindows()) || [];
  // Prefer the real editor shell over any auxiliary window (dialogs, previews).
  const match = windows.find((win) => /Cocos Creator/.test(win.getTitle ? win.getTitle() : ''));
  return match
    || (BrowserWindow.getFocusedWindow && BrowserWindow.getFocusedWindow())
    || windows[0]
    || null;
}

function captureEditorWindow() {
  const target = findEditorWindow();
  if (!target || typeof target.capturePage !== 'function') {
    throw new Error('No capturable editor window was found.');
  }
  return target.capturePage();
}

// Enumerate the Electron windows the host exposes so callers can target the
// right one (editor shell vs. dialogs/previews). Requires the editor host.
function listEditorWindows() {
  let electron;
  try {
    electron = require('electron');
  } catch (error) {
    throw new Error('Electron is unavailable in this Cocos extension host.');
  }
  const BrowserWindow = electron.BrowserWindow;
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
    throw new Error('Electron BrowserWindow is unavailable.');
  }
  return BrowserWindow.getAllWindows().map((win, index) => {
    const title = typeof win.getTitle === 'function' ? win.getTitle() : '';
    return {
      index: index,
      id: typeof win.id === 'number' ? win.id : index,
      title: title,
      kind: /Cocos Creator/.test(title) ? 'editor' : 'other',
      bounds: typeof win.getBounds === 'function' ? win.getBounds() : null,
      visible: typeof win.isVisible === 'function' ? win.isVisible() : true,
      focused: typeof win.isFocused === 'function' ? win.isFocused() : false,
    };
  });
}

// The live scene is composited inside the editor main window, and the scene
// renderer's WebGL canvas cannot be read back (its drawing buffer is not
// preserved), which is why scene captures crop the window instead.
const SCENE_VIEW_RECT_SCRIPT =
  '(function(){' +
  'var host=document.getElementById("scene");' +
  'var root=(host&&host.shadowRoot)||host;' +
  'var view=root&&root.querySelector("#sceneView");' +
  'if(!view){return null;}' +
  'var rect=view.getBoundingClientRect();' +
  'return {x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)};' +
  '})()';

async function captureSceneViewWindow(options) {
  const target = findEditorWindow();
  const webContents = target && target.webContents;
  if (!target || typeof target.capturePage !== 'function' || !webContents || typeof webContents.executeJavaScript !== 'function') {
    throw new Error('No capturable editor window was found for the scene view.');
  }
  const rect = await webContents.executeJavaScript(SCENE_VIEW_RECT_SCRIPT);
  if (!rect || !rect.width || !rect.height) {
    throw new Error('The scene view region could not be located in the editor window.');
  }
  let image = await target.capturePage(rect);
  const width = Number(options && options.width);
  const height = Number(options && options.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 && typeof image.resize === 'function') {
    image = image.resize({ width: Math.round(width), height: Math.round(height) });
  }
  const size = image.getSize();
  return { dataUri: IMAGE_DATA_URI_PREFIX + image.toPNG().toString('base64'), width: size.width, height: size.height };
}

// The 2.4 editor keeps a "Game" preview panel inside the main window
// (UI-PANEL-FRAME#game-window wrapping a CANVAS#game). Unlike 3.x it is 0x0
// until a preview is actually running, so a zero-size rect means "not open".
const GAME_VIEW_RECT_SCRIPT =
  '(function(){' +
  'function rectOf(el){if(!el||!el.getBoundingClientRect){return null;}var r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};}' +
  'var canvas=rectOf(document.getElementById("game"));' +
  'if(canvas&&canvas.width>4&&canvas.height>4){return canvas;}' +
  'var panel=rectOf(document.getElementById("game-window"));' +
  'if(panel&&panel.width>4&&panel.height>4){return panel;}' +
  'return null;' +
  '})()';

async function captureGameViewWindow() {
  const target = findEditorWindow();
  const webContents = target && target.webContents;
  if (!target || typeof target.capturePage !== 'function' || !webContents || typeof webContents.executeJavaScript !== 'function') {
    throw new Error('No capturable editor window was found for the game view.');
  }
  const rect = await webContents.executeJavaScript(GAME_VIEW_RECT_SCRIPT);
  if (!rect || !rect.width || !rect.height) {
    throw new Error('The Game preview panel is not visible in the editor. Run a preview so the Game panel opens, then retry.');
  }
  const image = await target.capturePage(rect);
  const size = image.getSize();
  return { dataUri: IMAGE_DATA_URI_PREFIX + image.toPNG().toString('base64'), width: size.width, height: size.height, bounds: rect };
}

// 2.4 previews normally open in an external browser, but the editor can still
// host a dedicated preview/simulator window; prefer it and otherwise fall back
// to the in-editor Game panel.
function findPreviewWindow() {
  let electron;
  try {
    electron = require('electron');
  } catch (error) {
    return null;
  }
  const BrowserWindow = electron.BrowserWindow;
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
    return null;
  }
  return (BrowserWindow.getAllWindows() || []).find((win) => {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) {
      return false;
    }
    const title = typeof win.getTitle === 'function' ? win.getTitle() : '';
    return /preview|simulator/i.test(title);
  }) || null;
}

async function capturePreviewWindow(options) {
  const target = findPreviewWindow();
  if (target && typeof target.capturePage === 'function') {
    const image = await target.capturePage();
    const size = image.getSize();
    return {
      dataUri: IMAGE_DATA_URI_PREFIX + image.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
      windowTitle: typeof target.getTitle === 'function' ? target.getTitle() : '',
    };
  }
  return await captureGameViewWindow(options);
}

// PNG IHDR starts at byte 16 (width) and byte 20 (height) after the 8-byte
// signature and the 8-byte length/type header.
function readPngSize(buffer) {
  if (!buffer || buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function execCapture(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve();
    });
  });
}

async function captureDesktopImage(projectPath, options) {
  options = options || {};
  const outputDir = resolveProjectFilePath(projectPath, 'temp/mcp-captures');
  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = options.fileName || 'desktop-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.png';
  if (typeof fileName !== 'string' || fileName.length > 180 || /[\\/\0<>:"|?*\r\n]/.test(fileName) || !fileName.toLowerCase().endsWith('.png') || fileName === '.png') {
    throw new Error('fileName must be a plain PNG filename under temp/mcp-captures.');
  }
  const filePath = resolveProjectFilePath(projectPath, path.join(outputDir, fileName));

  if (process.platform === 'darwin') {
    await execCapture('screencapture', ['-x', filePath]);
  } else if (process.platform === 'win32') {
    const escaped = filePath.replace(/'/g, "''");
    const script =
      'Add-Type -AssemblyName System.Windows.Forms;' +
      'Add-Type -AssemblyName System.Drawing;' +
      '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;' +
      '$img=New-Object System.Drawing.Bitmap $b.Width,$b.Height;' +
      '$g=[System.Drawing.Graphics]::FromImage($img);' +
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);' +
      "$img.Save('" + escaped + "',[System.Drawing.Imaging.ImageFormat]::Png);" +
      '$g.Dispose();$img.Dispose()';
    await execCapture('powershell', ['-NoProfile', '-Command', script]);
  } else {
    try {
      await execCapture('gnome-screenshot', ['-f', filePath]);
    } catch (error) {
      await execCapture('import', ['-window', 'root', filePath]);
    }
  }

  const buffer = fs.readFileSync(filePath);
  const result = {
    dataUri: IMAGE_DATA_URI_PREFIX + buffer.toString('base64'),
    filePath: path.relative(projectPath, filePath).replace(/\\/g, '/'),
  };
  const size = readPngSize(buffer);
  if (size) {
    result.width = size.width;
    result.height = size.height;
  }
  return result;
}

function buildSnippet(filePath, lineNumber, contextLines) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const target = Number(lineNumber) || 1;
  const span = Math.max(0, Number(contextLines) || 0);
  const start = Math.max(1, target - span);
  const end = Math.min(lines.length, target + span);
  const snippet = [];
  for (let line = start; line <= end; line += 1) {
    const marker = line === target ? '>' : ' ';
    snippet.push(marker + ' ' + String(line).padStart(4, ' ') + ' | ' + lines[line - 1]);
  }
  return snippet.join('\n');
}

function createToolRegistry(options) {
  const getRuntimeContext = options.getRuntimeContext;
  const getStatus = options.getStatus;
  const interactionLog = options.interactionLog;
  const runtimeLog = options.runtimeLog;
  const sceneBridge = options.sceneBridge;
  const editorExecutor = options.editorExecutor;
  const onInteraction = options.onInteraction;

  // Best-effort notification so the docked panel can refresh its activity list
  // without polling. Never allowed to break a tool call.
  function notifyInteraction(name, status) {
    if (typeof onInteraction !== 'function') {
      return;
    }
    try {
      onInteraction(name, status);
    } catch (error) {
      // Activity updates are advisory only.
    }
  }

  // Scene mutations performed through the scene script bypass the editor's own
  // undo/dirty tracking, so the native "save scene" command is a no-op for them.
  // Persist explicitly instead: serialize the live graph in the scene renderer,
  // then write the .fire document next to the project so asset-db picks it up.
  async function saveCurrentScene() {
    const serialized = await sceneBridge.call('serializeScene', {});
    if (!serialized || typeof serialized.content !== 'string' || !serialized.content) {
      throw new Error('The scene script did not return serialized scene content.');
    }
    const filePath = editorApi.sceneFspathByUuid(serialized.uuid);
    if (!filePath) {
      throw new Error('Unable to resolve the file path for the current scene.');
    }
    const content = serialized.content.endsWith('\n') ? serialized.content : serialized.content + '\n';
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    const byteLength = Buffer.byteLength(content, 'utf8');
    const dbUrl = editorApi.fspathToDbUrl(filePath);
    if (existing === content) {
      return {
        saved: false,
        skipped: 'unchanged',
        sceneName: serialized.sceneName,
        uuid: serialized.uuid,
        path: filePath,
        dbUrl,
        byteLength,
      };
    }
    fs.writeFileSync(filePath, content, 'utf8');
    return {
      saved: true,
      sceneName: serialized.sceneName,
      uuid: serialized.uuid,
      path: filePath,
      dbUrl,
      byteLength,
      previousByteLength: existing === null ? -1 : Buffer.byteLength(existing, 'utf8'),
    };
  }

  // Tools whose successful execution can change the scene graph.
  const SCENE_MUTATING_TOOLS = {
    create_node: true,
    delete_node: true,
    set_node_transform: true,
    add_component: true,
    remove_component: true,
    set_component_property: true,
    reset_component_property: true,
    invoke_component_method: true,
    create_canvas: true,
    create_label: true,
    create_button: true,
    create_sprite: true,
    create_camera: true,
    set_camera_properties: true,
  };

  async function autoSaveScene(name, args) {
    if (name === 'save_current_scene') {
      return null;
    }
    const scriptContext = String((args && args.context) || '').toLowerCase();
    const runsInScene = name === 'execute_javascript' || name === 'execute_scene_script';
    if (runsInScene) {
      if (scriptContext !== 'scene') {
        return null;
      }
    } else if (!SCENE_MUTATING_TOOLS[name]) {
      return null;
    }
    try {
      return await saveCurrentScene();
    } catch (error) {
      return { saved: false, error: error.message };
    }
  }

  async function executeScript(context, args, call) {
    assertToolJavascriptSafety(args, getRuntimeContext());
    const payload = { code: args.code, args: args.args || {}, captureActivity: true };
    let packet;
    if (context === 'scene') {
      packet = await sceneBridge.call('executeCode', payload);
    } else if (context === 'editor') {
      if (typeof editorExecutor !== 'function') {
        throw new Error('Editor JavaScript execution is unavailable.');
      }
      packet = await editorExecutor(payload);
    } else {
      throw new Error("Unknown execution context '" + args.context + "'. Expected 'scene' or 'editor'.");
    }
    if (!packet || packet.kind !== SCRIPT_EXECUTION_PACKET) {
      return packet;
    }
    call.execution = packet.execution;
    if (packet.error) {
      throw new Error(packet.error.message);
    }
    return packet.value;
  }

  const nodeTargetSchema = {
    path: { type: 'string', description: 'Hierarchy path such as Canvas/Player.' },
    uuid: { type: 'string', description: 'Node uuid.' },
    name: { type: 'string', description: 'Fallback exact node name.' },
  };

  // Cocos Creator 2.4 camera property names (see applyCameraProperties in scene.js).
  const cameraPropertySchema = {
    depth: { type: 'number', description: 'Camera depth (render order); higher values render on top.' },
    cullingMask: { type: 'number', description: 'Culling mask bitfield.' },
    clearFlags: { description: 'Clear flags bitmask, an array such as ["COLOR","DEPTH"], or a "COLOR|DEPTH|STENCIL" string.' },
    ortho: { type: 'boolean', description: 'Whether the camera uses orthographic projection.' },
    orthoSize: { type: 'number', description: 'Orthographic viewport size.' },
    fov: { type: 'number', description: 'Perspective field of view in degrees.' },
    nearClip: { type: 'number', description: 'Near clipping plane.' },
    farClip: { type: 'number', description: 'Far clipping plane.' },
    zoomRatio: { type: 'number', description: 'Camera zoom ratio (2D cameras only).' },
  };

  const tools = [
    {
      name: 'execute_javascript',
      profile: 'core',
      description: '[primary] Execute JavaScript in either the scene or editor context. Use context="scene" for live scene/runtime inspection and mutation, or context="editor" for Editor APIs, asset workflows, and local filesystem access.',
      inputSchema: createSchema({
        context: { type: 'string', description: 'Execution context: scene or editor.' },
        code: { type: 'string', description: 'JavaScript code to execute. May directly return a value, define run(env), or export a function.' },
        args: { type: 'object', description: 'Optional JSON object passed into the script.' },
        safety_checks: { type: 'boolean', description: 'Override the project default JavaScript safety checks for this call.' },
      }, ['context', 'code']),
      handler: async (args, call) => executeScript(String(args.context || '').toLowerCase(), args, call),
    },
    {
      name: 'execute_scene_script',
      profile: 'core',
      description: '[compat] Execute JavaScript in the active Cocos scene context. Prefer execute_javascript with context="scene".',
      inputSchema: createSchema({
        code: { type: 'string', description: 'JavaScript code to execute inside the scene script context.' },
        args: { type: 'object', description: 'Optional JSON object passed to the scene script.' },
        safety_checks: { type: 'boolean', description: 'Override the project default JavaScript safety checks for this call.' },
      }, ['code']),
      handler: async (args, call) => executeScript('scene', args, call),
    },
    {
      name: 'execute_editor_script',
      profile: 'core',
      description: '[compat] Execute JavaScript in the editor context. Prefer execute_javascript with context="editor".',
      inputSchema: createSchema({
        code: { type: 'string', description: 'JavaScript code to execute inside the editor context.' },
        args: { type: 'object', description: 'Optional JSON object passed to the editor script.' },
        safety_checks: { type: 'boolean', description: 'Override the project default JavaScript safety checks for this call.' },
      }, ['code']),
      handler: async (args, call) => executeScript('editor', args, call),
    },
    {
      name: 'get_editor_state',
      profile: 'core',
      description: '[specialist] Return a structured editor-state snapshot including project info, server status, current selection, and the active scene summary.',
      inputSchema: createSchema({}, []),
      handler: async () => {
        const runtimeContext = getRuntimeContext();
        const status = typeof getStatus === 'function' ? getStatus() : null;
        let scene = null;
        try {
          const sceneInfo = await sceneBridge.call('getSceneInfo', { maxDepth: 1, includeComponents: false });
          scene = sceneInfo
            ? { sceneName: sceneInfo.sceneName, uuid: sceneInfo.uuid, childCount: sceneInfo.childCount }
            : null;
        } catch (error) {
          scene = { error: error.message };
        }
        return {
          extensionName: runtimeContext.extensionName,
          version: runtimeContext.version,
          projectName: runtimeContext.projectName,
          projectPath: runtimeContext.projectPath,
          cocosVersion: runtimeContext.cocosVersion,
          toolProfile: runtimeContext.config ? runtimeContext.config.toolProfile : 'core',
          status: status,
          selection: getCurrentSelection(),
          scene: scene,
        };
      },
    },
    {
      name: 'get_project_info',
      profile: 'core',
      description: '[specialist] Return the active Cocos project path, version, and MCP server configuration.',
      inputSchema: createSchema({}, []),
      handler: async () => getRuntimeContext(),
    },
    {
      name: 'get_tool_catalog',
      profile: 'core',
      description: '[specialist] Return every built-in MCP tool with profile, category, and current exposure state.',
      inputSchema: createSchema({}, []),
      handler: async () => registry.listToolCatalog(),
    },
    {
      name: 'get_selection',
      profile: 'core',
      description: '[specialist] Return the current editor selection in a compact structured form.',
      inputSchema: createSchema({}, []),
      handler: async () => getCurrentSelection(),
    },
    {
      name: 'set_selection',
      profile: 'core',
      description: '[specialist] Set or clear the current editor selection for an asset or node.',
      inputSchema: createSchema({
        type: { type: 'string', description: 'Selection target type: asset, node, or clear.' },
        target: { type: 'string', description: 'Asset uuid/path/db url, or node uuid when type=node.' },
        clearMode: { type: 'string', description: 'When type=clear, choose asset, node, or all.' },
      }, ['type']),
      handler: async (args) => {
        const type = String(args.type || '').trim().toLowerCase();
        if (type === 'clear') {
          return clearSelection(args.clearMode || 'all');
        }
        if (type === 'asset') {
          const info = queryAssetInfo(args.target);
          return editorApi.setSelection('asset', info.uuid || args.target);
        }
        if (type === 'node') {
          const target = String(args.target || '').trim();
          if (!target) {
            throw new Error('target is required when type=node.');
          }
          return selectNode(target);
        }
        throw new Error("Unknown selection type '" + args.type + "'. Expected asset, node, or clear.");
      },
    },
    {
      name: 'get_editor_selection',
      profile: 'core',
      description: '[compat] Return the current node and asset selection in the Cocos editor. Prefer get_selection as the primary structured selection read tool.',
      inputSchema: createSchema({}, []),
      handler: async () => getCurrentSelection(),
    },
    {
      name: 'select_asset',
      profile: 'core',
      description: '[specialist] Select an asset (and reveal it) in the Cocos editor by uuid, db url, or path.',
      inputSchema: createSchema({
        target: { type: 'string', description: 'Asset uuid, db url, or path.' },
      }, ['target']),
      handler: async (args) => {
        const info = queryAssetInfo(args.target);
        return selectAsset(info.uuid || args.target);
      },
    },
    {
      name: 'get_scene_info',
      profile: 'core',
      description: '[specialist] Return a structured summary of the active Cocos scene.',
      inputSchema: createSchema({
        maxDepth: { type: 'number', description: 'Maximum child depth to include.' },
        includeComponents: { type: 'boolean', description: 'Include component names for nodes.' },
      }, []),
      handler: async (args) => sceneBridge.call('getSceneInfo', args),
    },
    {
      name: 'get_hierarchy',
      profile: 'core',
      description: '[specialist] Return a structured hierarchy tree from the active scene or a specific node path.',
      inputSchema: createSchema({
        rootPath: { type: 'string', description: 'Optional node path to use as the traversal root.' },
        maxDepth: { type: 'number', description: 'Maximum child depth to include.' },
        includeComponents: { type: 'boolean', description: 'Include component names for each node.' },
        includeInactive: { type: 'boolean', description: 'Include inactive nodes in the result.' },
      }, []),
      handler: async (args) => sceneBridge.call('getHierarchy', args),
    },
    {
      name: 'save_current_scene',
      profile: 'core',
      description: '[core] Save the currently open Cocos scene to disk. Scene edits made through this extension bypass the editor\'s dirty tracking, so the native save command does nothing for them — call this to persist them.',
      inputSchema: createSchema({}, []),
      handler: async () => await saveCurrentScene(),
    },
    {
      name: 'find_nodes',
      profile: 'core',
      description: 'Find scene nodes by exact name, partial path, or component type.',
      inputSchema: createSchema({
        name: { type: 'string', description: 'Exact node name to match.' },
        pathContains: { type: 'string', description: 'Substring that must appear in the node path.' },
        component: { type: 'string', description: 'Component constructor name to match.' },
        includeInactive: { type: 'boolean', description: 'Include inactive nodes.' },
      }, []),
      handler: async (args) => sceneBridge.call('findNodes', args),
    },
    {
      name: 'inspect_node',
      profile: 'core',
      description: 'Inspect a specific node by path, uuid, or name.',
      inputSchema: createSchema(nodeTargetSchema, []),
      handler: async (args) => sceneBridge.call('inspectNode', args),
    },
    {
      name: 'create_node',
      profile: 'core',
      description: 'Create a new node under the active scene or a specified parent path.',
      inputSchema: createSchema({
        name: { type: 'string', description: 'Name of the node to create.' },
        parentPath: { type: 'string', description: 'Optional parent node path.' },
        position: { type: 'object', description: 'Optional position {x,y,z}.' },
        scale: { type: 'object', description: 'Optional scale {x,y,z}.' },
        eulerAngles: { type: 'object', description: 'Optional rotation {x,y,z} in degrees.' },
        active: { type: 'boolean', description: 'Optional active state for the node.' },
      }, ['name']),
      handler: async (args) => sceneBridge.call('createNode', args),
    },
    {
      name: 'delete_node',
      profile: 'core',
      description: 'Delete a node by path, uuid, or name.',
      inputSchema: createSchema(nodeTargetSchema, []),
      handler: async (args) => sceneBridge.call('deleteNode', args),
    },
    {
      name: 'set_node_transform',
      profile: 'core',
      description: 'Update node position, rotation, scale, or active state.',
      inputSchema: createSchema(Object.assign({}, nodeTargetSchema, {
        position: { type: 'object', description: 'Position {x,y,z}.' },
        scale: { type: 'object', description: 'Scale {x,y,z}.' },
        eulerAngles: { type: 'object', description: 'Rotation {x,y,z} in degrees.' },
        active: { type: 'boolean', description: 'Optional active state.' },
      }), []),
      handler: async (args) => sceneBridge.call('setNodeTransform', args),
    },
    {
      name: 'list_components',
      profile: 'core',
      description: 'List the components attached to a node.',
      inputSchema: createSchema(nodeTargetSchema, []),
      handler: async (args) => sceneBridge.call('listComponents', args),
    },
    {
      name: 'add_component',
      profile: 'core',
      description: 'Add a component to a node by class name (for example cc.Sprite or cc.Label).',
      inputSchema: createSchema(Object.assign({}, nodeTargetSchema, {
        componentName: { type: 'string', description: 'Component class name, for example cc.Sprite.' },
      }), ['componentName']),
      handler: async (args) => sceneBridge.call('addComponent', args),
    },
    {
      name: 'remove_component',
      profile: 'core',
      description: 'Remove a component from a node by index or class name.',
      inputSchema: createSchema(Object.assign({}, nodeTargetSchema, {
        index: { type: 'number', description: 'Component index within the node.' },
        componentName: { type: 'string', description: 'Component class name.' },
      }), []),
      handler: async (args) => sceneBridge.call('removeComponent', args),
    },
    {
      name: 'inspect_component',
      profile: 'core',
      description: 'Inspect a component attached to a node and return its serializable data.',
      inputSchema: createSchema(Object.assign({}, nodeTargetSchema, {
        index: { type: 'number', description: 'Component index within the node.' },
        componentName: { type: 'string', description: 'Component class name.' },
      }), []),
      handler: async (args) => sceneBridge.call('inspectComponent', args),
    },
    {
      name: 'set_component_property',
      profile: 'core',
      description: 'Set a component property by dotted property path.',
      inputSchema: createSchema(Object.assign({}, nodeTargetSchema, {
        index: { type: 'number', description: 'Component index within the node.' },
        componentName: { type: 'string', description: 'Component class name.' },
        propertyPath: { type: 'string', description: 'Dotted property path, for example string or node.color.r.' },
        value: { description: 'Value to assign.' },
      }), ['propertyPath']),
      handler: async (args) => sceneBridge.call('setComponentProperty', args),
    },
    {
      name: 'invoke_component_method',
      profile: 'core',
      description: 'Invoke a method on a component attached to a node, for runtime validation and test hooks.',
      inputSchema: createSchema(Object.assign({}, nodeTargetSchema, {
        index: { type: 'number', description: 'Component index within the node.' },
        componentName: { type: 'string', description: 'Component class name.' },
        methodName: { type: 'string', description: 'Method name to invoke.' },
        args: { type: 'array', description: 'Optional argument array passed to the method.' },
      }), ['methodName']),
      handler: async (args) => sceneBridge.call('invokeComponentMethod', args),
    },
    {
      name: 'reset_component_property',
      profile: 'core',
      description: 'Reset a component property to its declared class default by dotted property path.',
      inputSchema: createSchema(Object.assign({}, nodeTargetSchema, {
        index: { type: 'number', description: 'Component index within the node.' },
        componentName: { type: 'string', description: 'Component class name.' },
        propertyPath: { type: 'string', description: 'Dotted property path to reset, for example string or node.color.r.' },
      }), ['propertyPath']),
      handler: async (args) => sceneBridge.call('resetComponentProperty', args),
    },
    {
      name: 'create_canvas',
      profile: 'core',
      description: 'Create a Canvas node with a cc.Canvas component.',
      inputSchema: createSchema({
        name: { type: 'string', description: 'Optional node name. Defaults to Canvas.' },
        parentPath: { type: 'string', description: 'Optional parent node path.' },
        width: { type: 'number', description: 'Content width in pixels.' },
        height: { type: 'number', description: 'Content height in pixels.' },
        position: { type: 'object' },
        scale: { type: 'object' },
      }, []),
      handler: async (args) => sceneBridge.call('createCanvas', args),
    },
    {
      name: 'create_label',
      profile: 'core',
      description: 'Create a Label node with a cc.Label component.',
      inputSchema: createSchema({
        name: { type: 'string' },
        parentPath: { type: 'string' },
        text: { type: 'string', description: 'Label text.' },
        fontSize: { type: 'number' },
        lineHeight: { type: 'number' },
        color: { description: 'Hex string or {r,g,b,a}.' },
        width: { type: 'number' },
        height: { type: 'number' },
        position: { type: 'object' },
      }, []),
      handler: async (args) => sceneBridge.call('createLabel', args),
    },
    {
      name: 'create_button',
      profile: 'core',
      description: 'Create a Button node with Sprite + Button components and a child Label.',
      inputSchema: createSchema({
        name: { type: 'string' },
        parentPath: { type: 'string' },
        text: { type: 'string' },
        fontSize: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        backgroundColor: { description: 'Hex string or {r,g,b,a}.' },
        textColor: { description: 'Hex string or {r,g,b,a}.' },
        position: { type: 'object' },
      }, []),
      handler: async (args) => sceneBridge.call('createButton', args),
    },
    {
      name: 'create_sprite',
      profile: 'core',
      description: 'Create a Sprite node with a cc.Sprite component.',
      inputSchema: createSchema({
        name: { type: 'string' },
        parentPath: { type: 'string' },
        color: { description: 'Hex string or {r,g,b,a}.' },
        spriteFrameUuid: { type: 'string', description: 'Optional sprite frame asset uuid.' },
        width: { type: 'number' },
        height: { type: 'number' },
        position: { type: 'object' },
      }, []),
      handler: async (args) => sceneBridge.call('createSprite', args),
    },
    {
      name: 'list_cameras',
      profile: 'core',
      description: '[specialist] List Camera components in the active scene.',
      inputSchema: createSchema({}, []),
      handler: async (args) => sceneBridge.call('listCameras', args),
    },
    {
      name: 'create_camera',
      profile: 'core',
      description: 'Create a Camera node in the active scene.',
      inputSchema: createSchema(Object.assign({
        name: { type: 'string', description: 'Camera node name. Defaults to Camera.' },
        parentPath: { type: 'string', description: 'Optional parent node path.' },
        position: { type: 'object', description: 'Optional position {x,y,z}.' },
        scale: { type: 'object', description: 'Optional scale {x,y,z}.' },
        eulerAngles: { type: 'object', description: 'Optional rotation {x,y,z} in degrees.' },
        active: { type: 'boolean', description: 'Optional active state.' },
      }, cameraPropertySchema), []),
      handler: async (args) => sceneBridge.call('createCamera', args),
    },
    {
      name: 'set_camera_properties',
      profile: 'core',
      description: 'Set properties on the Camera component of a node.',
      inputSchema: createSchema(Object.assign({}, nodeTargetSchema, cameraPropertySchema), []),
      handler: async (args) => sceneBridge.call('setCameraProperties', args),
    },
    {
      name: 'list_scenes',
      profile: 'core',
      description: '[specialist] List scene assets in the project.',
      inputSchema: createSchema({
        pattern: { type: 'string', description: 'Optional asset pattern filter.' },
      }, []),
      handler: async (args) => {
        const assets = await listAssets({ pattern: args.pattern, ccType: 'cc.SceneAsset' });
        return { count: assets.length, scenes: assets.slice(0, 200) };
      },
    },
    {
      name: 'open_scene',
      profile: 'core',
      description: '[specialist] Open a scene asset in Cocos Creator by uuid, db url, or path.',
      inputSchema: createSchema({
        target: { type: 'string', description: 'Scene uuid, db url, or path.' },
      }, ['target']),
      handler: async (args) => openAsset(args.target),
    },
    {
      name: 'create_scene',
      profile: 'core',
      description: 'Create an empty scene asset at an explicit assets path using the built-in 2.4 scene template.',
      inputSchema: createSchema({
        target: { type: 'string', description: 'Target scene path under assets, such as assets/Scenes/Level01.fire.' },
        sceneName: { type: 'string', description: 'Optional internal scene name.' },
        overwrite: { type: 'boolean', description: 'Overwrite an existing scene asset at target.' },
        openAfterCreate: { type: 'boolean', description: 'Open the created scene after it is persisted. Defaults to false.' },
      }, ['target']),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const target = normalizeSceneTarget(runtimeContext.projectPath, args.target);
        const content = loadEmptySceneTemplate(args.sceneName || target.sceneName);
        const result = await saveSceneContent(runtimeContext.projectPath, {
          target: target.projectRelative,
          content: content,
          overwrite: args.overwrite,
        });
        const opened = args.openAfterCreate === true ? openAsset(result.dbUrl) : null;
        return Object.assign({}, result, {
          mode: 'empty',
          source: 'template:new-scene.fire',
          opened: opened,
        });
      },
    },
    {
      name: 'list_assets',
      profile: 'core',
      description: '[specialist] List project assets, optionally filtered by component/asset type.',
      inputSchema: createSchema({
        pattern: { type: 'string', description: 'Optional asset pattern filter.' },
        ccType: { type: 'string', description: 'Asset type such as cc.Prefab or cc.SpriteFrame. Defaults to cc.Asset.' },
      }, []),
      handler: async (args) => {
        const assets = await listAssets({ pattern: args.pattern, ccType: args.ccType || 'cc.Asset' });
        return { count: assets.length, assets: assets.slice(0, 200) };
      },
    },
    {
      name: 'inspect_asset',
      profile: 'core',
      description: '[specialist] Inspect an asset by uuid, db url, or path.',
      inputSchema: createSchema({
        target: { type: 'string', description: 'Asset uuid, db url, or path.' },
      }, ['target']),
      handler: async (args) => {
        const info = queryAssetInfo(args.target);
        let meta = null;
        try {
          meta = queryAssetMeta(args.target);
        } catch (error) {
          meta = { error: error.message };
        }
        return { info: info, url: queryAssetUrl(args.target), meta: meta };
      },
    },
    {
      name: 'open_asset',
      profile: 'core',
      description: '[specialist] Open an asset (for example a scene or prefab) in Cocos Creator.',
      inputSchema: createSchema({
        target: { type: 'string', description: 'Asset uuid, db url, or path.' },
      }, ['target']),
      handler: async (args) => openAsset(args.target),
    },
    {
      name: 'delete_asset',
      profile: 'core',
      description: 'Delete an asset by uuid, db url, or path.',
      inputSchema: createSchema({
        target: { type: 'string', description: 'Asset uuid, db url, or path.' },
      }, ['target']),
      handler: async (args) => deleteAsset(args.target),
    },
    {
      name: 'get_recent_logs',
      profile: 'core',
      description: '[specialist] Return recent MCP runtime logs and interactions recorded by the embedded server.',
      inputSchema: createSchema({
        limit: { type: 'number', description: 'Maximum number of entries to return.' },
      }, []),
      handler: async (args) => {
        const limit = Number.isFinite(args.limit) ? args.limit : 50;
        return {
          runtime: runtimeLog ? runtimeLog.list(limit) : [],
          interactions: interactionLog ? interactionLog.list(limit) : [],
        };
      },
    },
    {
      name: 'run_script_diagnostics',
      profile: 'core',
      description: '[specialist] Run a TypeScript no-emit check for the current Cocos project and return parsed diagnostics.',
      inputSchema: createSchema({
        tsconfigPath: { type: 'string', description: 'Optional path to the tsconfig file to use.' },
      }, []),
      handler: async (args) => {
        const { projectPath } = getRuntimeContext();
        return await runScriptDiagnostics(projectPath, args || {});
      },
    },
    {
      name: 'get_script_diagnostic_context',
      profile: 'core',
      description: '[specialist] Run TypeScript diagnostics and attach a source snippet for each error.',
      inputSchema: createSchema({
        tsconfigPath: { type: 'string', description: 'Optional path to the tsconfig file to use.' },
        contextLines: { type: 'number', description: 'Number of surrounding source lines per diagnostic.' },
        limit: { type: 'number', description: 'Maximum diagnostics to include.' },
      }, []),
      handler: async (args) => {
        args = args || {};
        const { projectPath } = getRuntimeContext();
        const result = await runScriptDiagnostics(projectPath, args);
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(50, args.limit)) : 10;
        const contextLines = Number.isFinite(args.contextLines) ? Math.max(0, Math.min(20, args.contextLines)) : 3;
        const diagnostics = result.diagnostics.slice(0, limit).map((diagnostic) => {
          const filePath = path.isAbsolute(diagnostic.file) ? diagnostic.file : path.join(projectPath, diagnostic.file);
          return Object.assign({}, diagnostic, {
            snippet: fs.existsSync(filePath) ? buildSnippet(filePath, diagnostic.line, contextLines) : 'Source file not found.',
          });
        });
        return Object.assign({}, result, { diagnostics: diagnostics });
      },
    },
    {
      name: 'search_project_logs',
      profile: 'core',
      description: '[specialist] Search common Cocos project log files for a string or regular expression.',
      inputSchema: createSchema({
        query: { type: 'string', description: 'Text or regex pattern to search for.' },
        regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression.' },
        caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching.' },
        limit: { type: 'number', description: 'Maximum matches to return.' },
        directory: { type: 'string', description: 'Optional project-relative log directory to search.' },
      }, ['query']),
      handler: async (args) => {
        const { projectPath } = getRuntimeContext();
        return searchProjectLogs(projectPath, args || {});
      },
    },
    {
      name: 'clear_logs',
      profile: 'core',
      description: '[specialist] Clear in-memory MCP logs and, only with explicit confirmation, truncate common project log files.',
      inputSchema: createSchema({
        scope: { type: 'string', description: 'mcp, project, or all. Defaults to mcp.' },
        confirmProjectLogs: { type: 'boolean', description: 'Required when scope includes project log files.' },
        directory: { type: 'string', description: 'Optional project-relative log directory to clear.' },
      }, []),
      handler: async (args) => {
        args = args || {};
        const { projectPath } = getRuntimeContext();
        const scope = String(args.scope || 'mcp').toLowerCase();
        const clearMcp = scope === 'mcp' || scope === 'all';
        const clearProject = scope === 'project' || scope === 'all';
        if (!clearMcp && !clearProject) {
          throw new Error("scope must be 'mcp', 'project', or 'all'.");
        }
        const result = { runtimeLogEntriesCleared: 0, interactionEntriesCleared: 0, projectLogFilesCleared: [] };
        if (clearMcp) {
          result.runtimeLogEntriesCleared = runtimeLog && typeof runtimeLog.clear === 'function' ? runtimeLog.clear() : 0;
          result.interactionEntriesCleared = interactionLog && typeof interactionLog.clear === 'function' ? interactionLog.clear() : 0;
        }
        if (clearProject) {
          if (!args.confirmProjectLogs) {
            throw new Error('confirmProjectLogs=true is required before truncating project log files.');
          }
          result.projectLogFilesCleared = clearProjectLogFiles(projectPath, { directory: args.directory, limit: 50 });
        }
        return result;
      },
    },
    {
      name: 'capture_scene_screenshot',
      profile: 'core',
      description: '[specialist] Capture a PNG screenshot of the active Cocos scene view.',
      inputSchema: createSchema({
        width: { type: 'number', description: 'Optional capture width hint.' },
        height: { type: 'number', description: 'Optional capture height hint.' },
      }, []),
      handler: async (args) => await captureSceneViewWindow(args || {}),
    },
    {
      name: 'capture_editor_screenshot',
      profile: 'core',
      description: '[specialist] Capture a PNG screenshot of the focused Cocos Creator editor window.',
      inputSchema: createSchema({}, []),
      handler: async () => {
        const image = await captureEditorWindow();
        const size = image.getSize();
        return { dataUri: IMAGE_DATA_URI_PREFIX + image.toPNG().toString('base64'), width: size.width, height: size.height };
      },
    },
    {
      name: 'capture_desktop_screenshot',
      profile: 'core',
      description: '[specialist] Capture a screenshot of the local desktop and return it as an MCP image payload.',
      inputSchema: createSchema({
        fileName: { type: 'string', description: 'Optional output file name under temp/mcp-captures.' },
      }, []),
      handler: async (args) => {
        const { projectPath } = getRuntimeContext();
        return await captureDesktopImage(projectPath, args || {});
      },
    },
    {
      name: 'capture_game_screenshot',
      profile: 'core',
      description: '[specialist] Capture the Game preview panel region of the editor window as an MCP image payload.',
      inputSchema: createSchema({
        fileName: { type: 'string', description: 'Optional output file name hint.' },
      }, []),
      handler: async (args) => await captureGameViewWindow(args || {}),
    },
    {
      name: 'capture_preview_screenshot',
      profile: 'core',
      description: '[specialist] Capture the preview or simulator output as an MCP image payload.',
      inputSchema: createSchema({
        fileName: { type: 'string', description: 'Optional output file name hint.' },
      }, []),
      handler: async (args) => await capturePreviewWindow(args || {}),
    },
    {
      name: 'list_editor_windows',
      profile: 'core',
      description: '[specialist] List the Electron windows the editor exposes so callers can target the correct window.',
      inputSchema: createSchema({}, []),
      handler: async () => {
        const windows = listEditorWindows();
        return { count: windows.length, windows: windows };
      },
    },
  ];

  const registry = {
    listTools() {
      const config = getRuntimeContext().config;
      return tools
        .filter((tool) => isToolExposed(config || {}, tool))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema || createOutputSchema(tool.dataSchema),
          annotations: inferToolAnnotations(tool),
        }));
    },

    listToolCatalog() {
      const config = getRuntimeContext().config;
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        profile: tool.profile,
        category: toolCategory(tool),
        annotations: inferToolAnnotations(tool),
        outputSchema: tool.outputSchema || createOutputSchema(tool.dataSchema),
        enabled: isToolExposed(config || {}, tool),
      }));
    },

    async callToolDetailed(name, args) {
      const config = getRuntimeContext().config;
      const tool = tools.find((item) => item.name === name);
      if (!tool) {
        throw new Error("Unknown tool '" + name + "'");
      }
      if (!isToolExposed(config || {}, tool)) {
        throw new Error("Tool '" + name + "' is not exposed by the current MCP tool profile '" + config.toolProfile + "'.");
      }

      const call = {};
      try {
        const result = await tool.handler(args || {}, call);
        const image = toolCategory(tool) === 'screenshots' && result && typeof result.dataUri === 'string' && result.dataUri.indexOf(IMAGE_DATA_URI_PREFIX) === 0
          ? result.dataUri
          : (typeof result === 'string' && result.indexOf(IMAGE_DATA_URI_PREFIX) === 0 ? result : null);
        let data = result;
        if (image && result && typeof result === 'object') {
          data = Object.assign({}, result);
          delete data.dataUri;
          data.image = true;
          data.mimeType = 'image/png';
          data.byteLength = Buffer.byteLength(image.slice(IMAGE_DATA_URI_PREFIX.length), 'base64');
        }
        const envelope = createResultEnvelope(tool, args || {}, data);
        if (call.execution) {
          envelope.execution = call.execution;
        }
        const autoSave = await autoSaveScene(name, args || {});
        if (autoSave) {
          envelope.autoSave = autoSave;
        }
        const output = image ? image : toOutput(envelope);
        interactionLog.add(name, 'success', envelope.summary.slice(0, 500), envelope.data, call.execution);
        notifyInteraction(name, 'success');
        return {
          value: envelope,
          text: output,
          metadataText: image && result && typeof result === 'object' ? toOutput(envelope) : undefined,
        };
      } catch (error) {
        interactionLog.add(name, 'error', error.message, undefined, call.execution);
        notifyInteraction(name, 'error');
        error.toolEnvelope = createResultEnvelope(tool, args || {}, { message: error.message }, {
          ok: false,
          summary: error.message,
        });
        if (call.execution) {
          error.toolEnvelope.execution = call.execution;
        }
        throw error;
      }
    },

    async callTool(name, args) {
      const result = await registry.callToolDetailed(name, args);
      return result.text;
    },
  };

  return registry;
}

module.exports = {
  createToolRegistry,
  resolveProjectPath,
};
