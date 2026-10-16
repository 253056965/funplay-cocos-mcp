'use strict';

// Asset helpers backed by the Cocos Creator 2.4 Editor.assetdb API.
// Replaces the 3.x asset-db message requests used upstream.

const fs = require('fs');
const path = require('path');
const editorApi = require('./editor-api');

function getProjectPath() {
  const editor = editorApi.getEditor();
  if (editor && editor.Project && typeof editor.Project.path === 'string' && editor.Project.path) {
    return editor.Project.path;
  }
  return process.cwd();
}

function normalizeInfo(info, target) {
  if (!info) {
    return null;
  }
  const url = info.url || editorApi.toDbUrl(target);
  const uuid = info.uuid || editorApi.toUuid(target);
  return {
    uuid,
    url,
    path: info.path || (url ? url.replace('db://', '') : ''),
    type: info.type || info.assetType || '',
    name: info.name || (url ? path.basename(url) : ''),
    extname: info.extname || (url ? path.extname(url) : ''),
    isSubAsset: Boolean(info.isSubAsset),
  };
}

// 2.4 patterns like '**/*.fire' must be matched against the asset url; a plain
// substring test never matches because url is 'db://assets/scene/hello.fire'.
function globToRegExp(glob) {
  const source = String(glob);
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '*') {
      if (source[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.indexOf(char) !== -1) {
      out += '\\' + char;
    } else {
      out += char;
    }
  }
  return new RegExp(out + '$', 'i');
}

async function listAssets(options = {}) {
  const ccType = options.ccType ? String(options.ccType) : '';
  const results = await editorApi.listAssetsByType(ccType);
  const pattern = options.pattern ? String(options.pattern).trim() : '';
  const matcher = pattern ? globToRegExp(pattern) : null;
  return results
    .map((item) => normalizeInfo(item, item && item.url))
    .filter((item) => {
      if (!item) {
        return false;
      }
      if (!matcher) {
        return true;
      }
      const url = item.url || '';
      const relative = url.replace(/^db:\/\/assets\//, '');
      return matcher.test(url) || matcher.test(relative) || matcher.test(item.path || '');
    });
}

function queryAssetInfo(uuidOrPath) {
  if (!uuidOrPath) {
    throw new Error('Asset uuid or path is required.');
  }
  const info = editorApi.assetInfo(uuidOrPath);
  if (!info) {
    throw new Error('Asset not found: ' + uuidOrPath);
  }
  return normalizeInfo(info, uuidOrPath);
}

function queryAssetMeta(uuidOrPath) {
  const assetdb = editorApi.getAssetDb();
  const url = editorApi.toDbUrl(uuidOrPath);
  if (assetdb.loadMeta && url) {
    const meta = assetdb.loadMeta(url);
    if (meta) {
      return meta;
    }
  }
  const uuid = editorApi.toUuid(uuidOrPath);
  if (uuid && assetdb.loadMetaByUuid) {
    const meta = assetdb.loadMetaByUuid(uuid);
    if (meta) {
      return meta;
    }
  }
  throw new Error('Asset meta not found: ' + uuidOrPath);
}

function queryAssetData(uuidOrPath) {
  const info = queryAssetInfo(uuidOrPath);
  const fspath = editorApi.getAssetDb().uuidToFspath
    ? editorApi.getAssetDb().uuidToFspath(info.uuid)
    : '';
  if (!fspath || !fs.existsSync(fspath)) {
    throw new Error('Asset file not found on disk: ' + uuidOrPath);
  }
  return fs.readFileSync(fspath, 'utf8');
}

function queryAssetUrl(uuidOrPath) {
  const url = editorApi.toDbUrl(uuidOrPath);
  if (!url) {
    throw new Error('Asset URL not found: ' + uuidOrPath);
  }
  return url;
}

function openAsset(uuidOrPath) {
  const info = queryAssetInfo(uuidOrPath);
  const editor = editorApi.getEditor();
  if (editor && editor.Ipc && typeof editor.Ipc.sendToAll === 'function') {
    // 2.4 opens assets through the built-in assets panel.
    editor.Ipc.sendToAll('assets:hint', { uuid: info.uuid, url: info.url });
    editor.Ipc.sendToAll('assets:open', info.uuid);
  }
  return info;
}

function deleteAsset(uuidOrPath) {
  const info = queryAssetInfo(uuidOrPath);
  return editorApi.callAssetDb('delete', [info.url]).then(() => ({ deleted: true, url: info.url }));
}

function selectAsset(uuid) {
  const resolved = uuid && String(uuid).startsWith('db://')
    ? editorApi.toUuid(uuid)
    : (editorApi.assetInfo(uuid) ? editorApi.toUuid(uuid) : uuid);
  return editorApi.setSelection('asset', resolved);
}

function selectNode(uuid) {
  if (!uuid) {
    throw new Error('Node uuid is required.');
  }
  return editorApi.setSelection('node', uuid);
}

function clearSelection(type) {
  return editorApi.clearSelection(type);
}

function getCurrentSelection() {
  const asset = editorApi.getSelection('asset');
  const node = editorApi.getSelection('node');
  return {
    asset: asset || '',
    node: node || '',
    type: node ? 'node' : (asset ? 'asset' : ''),
  };
}

function getProjectRoot() {
  return getProjectPath();
}

module.exports = {
  clearSelection,
  deleteAsset,
  getCurrentSelection,
  getProjectRoot,
  listAssets,
  openAsset,
  queryAssetData,
  queryAssetInfo,
  queryAssetMeta,
  queryAssetUrl,
  selectAsset,
  selectNode,
};
