'use strict';

// Adapter layer that hides Cocos Creator 2.4 vs 3.x editor API differences
// behind a single, promise-friendly surface used by the MCP tool registry.

function getEditor() {
  return typeof global !== 'undefined' ? global.Editor : undefined;
}

function assertEditor(what) {
  const editor = getEditor();
  if (!editor) {
    throw new Error('Editor is unavailable in this Cocos extension host.');
  }
  if (what && !editor[what]) {
    throw new Error('Editor.' + what + ' is unavailable in this Cocos extension host.');
  }
  return editor;
}

function getExtensionName() {
  const editor = getEditor();
  if (editor && editor.Package && editor.Package.name) {
    return String(editor.Package.name);
  }
  try {
    return require('../package.json').name;
  } catch (error) {
    return 'funplay-cocos-mcp';
  }
}

// Call a message exported by this package's scene script (scene.js).
// Cocos Creator 2.4 uses Editor.Scene.callSceneScript(pkg, method, ...args, cb).
// Older/newer hosts may not expose it, so a few fallbacks are attempted.
function callSceneScript(method, payload) {
  const editor = assertEditor();
  const name = String(method || '').trim();
  if (!name) {
    return Promise.reject(new Error('Scene script method is required.'));
  }
  const args = payload === undefined ? [] : [payload];

  return new Promise((resolve, reject) => {
    const done = (error, result) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve(result);
    };

    try {
      if (editor.Scene && typeof editor.Scene.callSceneScript === 'function') {
        editor.Scene.callSceneScript(getExtensionName(), name, args[0], done);
        return;
      }
    } catch (error) {
      reject(error);
      return;
    }

    // Compatibility fallback: some 2.x builds shipped the scene bridge through
    // a generic IPC request on the built-in 'scene' package.
    try {
      if (editor.Ipc && typeof editor.Ipc.sendToMain === 'function') {
        editor.Ipc.sendToMain('scene:call-scene-script', getExtensionName(), name, args[0], done);
        return;
      }
    } catch (error) {
      reject(error);
      return;
    }

    reject(new Error('Scene script bridge is unavailable: Editor.Scene.callSceneScript is not a function.'));
  });
}

// ---- AssetDB ---------------------------------------------------------------

function getAssetDb() {
  const editor = assertEditor('assetdb');
  if (!editor.assetdb) {
    throw new Error('Editor.assetdb is unavailable in this Cocos extension host.');
  }
  return editor.assetdb;
}

function callAssetDb(method, args) {
  const assetdb = getAssetDb();
  const fn = assetdb[method];
  if (typeof fn !== 'function') {
    return Promise.reject(new Error('Editor.assetdb.' + method + ' is unavailable.'));
  }
  return new Promise((resolve, reject) => {
    fn.apply(assetdb, (args || []).concat([(error, result) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve(result);
    }]));
  });
}

// Convert a uuid / db url / project-relative path into an asset url (db://...).
function toDbUrl(target) {
  const assetdb = getAssetDb();
  const raw = String(target || '').trim().replace(/\\/g, '/');
  if (!raw) {
    return '';
  }
  if (raw.startsWith('db://')) {
    return raw;
  }
  if (assetdb.existsByUuid && assetdb.existsByUuid(raw)) {
    return assetdb.uuidToUrl(raw);
  }
  if (raw.startsWith('/')) {
    return raw;
  }
  if (raw.startsWith('assets/')) {
    return 'db://' + raw;
  }
  return 'db://assets/' + raw;
}

function toUuid(target) {
  const assetdb = getAssetDb();
  const raw = String(target || '').trim().replace(/\\/g, '/');
  if (!raw) {
    return '';
  }
  if (assetdb.existsByUuid && assetdb.existsByUuid(raw)) {
    return raw;
  }
  const url = raw.startsWith('db://') ? raw : toDbUrl(raw);
  return assetdb.urlToUuid(url) || '';
}

function fspathToDbUrl(fspath) {
  const assetdb = getAssetDb();
  const raw = String(fspath || '').trim().replace(/\\/g, '/');
  if (!raw) {
    return '';
  }
  if (raw.startsWith('db://')) {
    return raw;
  }
  if (typeof assetdb.fspathToUrl === 'function') {
    const url = assetdb.fspathToUrl(raw);
    if (typeof url === 'string' && url) {
      return url;
    }
  }
  const marker = '/assets/';
  const index = raw.indexOf(marker);
  if (index !== -1) {
    return 'db://assets/' + raw.slice(index + marker.length);
  }
  return '';
}

function sceneFspathByUuid(uuid) {
  const assetdb = getAssetDb();
  const raw = String(uuid || '').trim();
  if (!raw) {
    return '';
  }
  if (typeof assetdb.uuidToFspath === 'function') {
    const fspath = assetdb.uuidToFspath(raw);
    if (typeof fspath === 'string' && fspath) {
      return fspath;
    }
  }
  if (typeof assetdb.uuidToUrl === 'function' && typeof assetdb.urlToFspath === 'function') {
    const url = assetdb.uuidToUrl(raw);
    if (url) {
      return assetdb.urlToFspath(url) || '';
    }
  }
  return '';
}

function assetInfo(target) {
  const assetdb = getAssetDb();
  const url = target && String(target).startsWith('db://') ? String(target) : '';
  if (url && assetdb.assetInfo) {
    const info = assetdb.assetInfo(url);
    if (info) {
      return info;
    }
  }
  const uuid = toUuid(target);
  if (uuid && assetdb.assetInfoByUuid) {
    const info = assetdb.assetInfoByUuid(uuid);
    if (info) {
      return info;
    }
  }
  return null;
}

// Cocos Creator 2.4 filters assets by SHORT type tokens ('scene', 'prefab',
// 'sprite-frame', ...), not by 3.x-style class names such as 'cc.SceneAsset'.
// Passing a 'cc.*' name yields zero results, so map the common ones and fall
// back to client-side filtering for anything unknown.
const ASSET_TYPE_ALIASES = {
  'cc.SceneAsset': 'scene',
  'cc.Scene': 'scene',
  'cc.Prefab': 'prefab',
  'cc.SpriteFrame': 'sprite-frame',
  'cc.Texture2D': 'texture',
  'cc.Material': 'material',
  'cc.AnimationClip': 'animation-clip',
  'cc.SkeletonAnimationClip': 'skeleton-animation-clip',
  'cc.Skeleton': 'skeleton',
  'cc.AudioClip': 'audio-clip',
  'cc.JsonAsset': 'json',
  'cc.TextAsset': 'text',
  'cc.Font': 'font',
  'cc.BitmapFont': 'bitmap-font',
  'cc.LabelAtlas': 'label-atlas',
  'cc.Mesh': 'mesh',
  'cc.BufferAsset': 'buffer',
  'cc.EffectAsset': 'effect',
};

function to24AssetType(ccType) {
  const raw = String(ccType || '').trim();
  if (!raw) {
    return '';
  }
  if (Object.prototype.hasOwnProperty.call(ASSET_TYPE_ALIASES, raw)) {
    return ASSET_TYPE_ALIASES[raw];
  }
  // 'cc.Asset' (and any other unmapped cc.* class) means "no server-side filter".
  if (raw.indexOf('cc.') === 0) {
    return '';
  }
  return raw.toLowerCase();
}

function listAssetsByType(ccType) {
  return new Promise((resolve, reject) => {
    const assetdb = getAssetDb();
    if (typeof assetdb.queryAssets !== 'function') {
      reject(new Error('Editor.assetdb.queryAssets is unavailable.'));
      return;
    }
    const wanted = String(ccType || '').trim();
    const token = to24AssetType(wanted);
    assetdb.queryAssets('db://assets/**', token || null, (error, results) => {
      if (error) {
        reject(error);
        return;
      }
      let list = Array.isArray(results) ? results : [];
      // 'cc.Asset' means "every asset"; only filter when a concrete type was asked for.
      const wantsAll = !wanted || wanted.toLowerCase() === 'cc.asset';
      if (!token && !wantsAll) {
        const lower = wanted.toLowerCase();
        list = list.filter((item) => {
          const type = String((item && item.type) || '').toLowerCase();
          return type === lower || ('cc.' + type) === lower;
        });
      }
      resolve(list);
    });
  });
}

// ---- Selection -------------------------------------------------------------

function getSelection(type) {
  const editor = assertEditor('Selection');
  const selection = editor.Selection || {};
  const kind = type === 'asset' ? 'asset' : 'node';
  if (typeof selection.curSelection === 'function') {
    return selection.curSelection(kind) || '';
  }
  if (typeof selection.getSelected === 'function') {
    const value = selection.getSelected(kind);
    return Array.isArray(value) ? (value[0] || '') : (value || '');
  }
  return '';
}

function setSelection(type, uuid) {
  const editor = assertEditor('Selection');
  const selection = editor.Selection || {};
  const kind = type === 'asset' ? 'asset' : 'node';
  if (typeof selection.clear === 'function') {
    selection.clear(kind);
  }
  if (typeof selection.select === 'function') {
    selection.select(kind, uuid);
    return { selected: true, type: kind, uuid };
  }
  throw new Error('Editor.Selection.select is unavailable in this Cocos extension host.');
}

function clearSelection(type) {
  const editor = assertEditor('Selection');
  const selection = editor.Selection || {};
  const normalized = String(type || 'all').trim().toLowerCase();
  if (typeof selection.clear !== 'function') {
    throw new Error('Editor.Selection.clear is unavailable in this Cocos extension host.');
  }
  if (normalized === 'asset' || normalized === 'node') {
    selection.clear(normalized);
    return { cleared: true, type: normalized };
  }
  selection.clear('asset');
  selection.clear('node');
  return { cleared: true, type: 'all' };
}

module.exports = {
  getEditor,
  getExtensionName,
  callSceneScript,
  callAssetDb,
  getAssetDb,
  toDbUrl,
  toUuid,
  assetInfo,
  fspathToDbUrl,
  sceneFspathByUuid,
  listAssetsByType,
  getSelection,
  setSelection,
  clearSelection,
};
