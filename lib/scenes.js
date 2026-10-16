'use strict';

// Scene asset persistence for Cocos Creator 2.4 (.fire scenes) via Editor.assetdb.

const fs = require('fs');
const path = require('path');
const { resolveProjectPath } = require('./path-safety');
const editorApi = require('./editor-api');

const SCENE_EXTENSION = '.fire';

// Cocos Creator 2.4 has no editor-side scene serializer (3.x used
// cce.Utils.serialize). Empty scenes are produced from the built-in
// new-scene.fire template that ships with this extension package.
function getTemplatePath(relative) {
  const editor = editorApi.getEditor();
  if (editor && typeof editor.url === 'function') {
    try {
      return editor.url('packages://' + editorApi.getExtensionName() + '/' + relative);
    } catch (error) {
      return null;
    }
  }
  return null;
}

function loadEmptySceneTemplate(sceneName) {
  const templatePath = getTemplatePath('templates/new-scene.fire');
  if (!templatePath) {
    throw new Error('Unable to resolve the new-scene.fire template inside the extension package.');
  }
  let content;
  try {
    content = fs.readFileSync(templatePath, 'utf8');
  } catch (error) {
    throw new Error('Unable to read the new-scene.fire template: ' + error.message);
  }
  const name = String(sceneName || '').trim();
  if (name) {
    const parsed = JSON.parse(content);
    if (parsed && parsed[1]) {
      parsed[1]._name = name;
    }
    content = JSON.stringify(parsed, null, 2);
  }
  return content;
}

function getProjectPath() {
  const editor = editorApi.getEditor();
  if (editor && editor.Project && typeof editor.Project.path === 'string' && editor.Project.path) {
    return editor.Project.path;
  }
  return process.cwd();
}

function normalizeSceneTarget(projectPath, target) {
  const raw = String(target || '').trim().replace(/\\/g, '/');
  if (!raw) {
    throw new Error('target is required.');
  }

  let relative = raw;
  if (relative.startsWith('db://assets/')) {
    relative = relative.slice('db://'.length);
  } else if (relative.startsWith('/assets/')) {
    relative = relative.slice(1);
  } else if (!relative.startsWith('assets/')) {
    relative = 'assets/' + relative;
  }

  if (!relative.match(/\.(fire|scene)$/i)) {
    relative = relative + SCENE_EXTENSION;
  }

  const filePath = resolveProjectPath(projectPath, relative);
  const assetsRoot = path.join(projectPath, 'assets');
  const relativeToAssets = path.relative(assetsRoot, filePath);
  if (relativeToAssets.startsWith('..') || path.isAbsolute(relativeToAssets)) {
    throw new Error('target must be inside the Cocos assets directory.');
  }

  const projectRelative = path.relative(projectPath, filePath).replace(/\\/g, '/');
  return {
    filePath: filePath,
    projectRelative: projectRelative,
    dbUrl: 'db://' + projectRelative,
    sceneName: path.basename(filePath).replace(/\.(fire|scene)$/i, ''),
  };
}

function queryAssetInfoOptional(target) {
  try {
    return require('./assets').queryAssetInfo(target);
  } catch (error) {
    return null;
  }
}

function persistSceneAsset(target, content, existed) {
  const url = target.dbUrl;
  const data = content.endsWith('\n') ? content : content + '\n';
  const method = existed ? 'saveExists' : 'create';
  return editorApi.callAssetDb(method, [url, data])
    .then((result) => ({ method: 'assetdb:' + method, result: result }))
    .catch((error) => {
      // Fall back to a direct disk write plus refresh when asset-db rejects the call.
      fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
      fs.writeFileSync(target.filePath, data, 'utf8');
      return editorApi.callAssetDb('refresh', [url])
        .then(() => ({ method: 'fs-write', result: { fallbackReason: error.message } }))
        .catch(() => ({ method: 'fs-write', result: { fallbackReason: error.message } }));
    });
}

async function saveSceneContent(projectPath, options = {}) {
  const target = normalizeSceneTarget(projectPath, options.target);
  const content = String(options.content || '');
  if (!content) {
    throw new Error('content is required.');
  }

  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('content must be a serialized Cocos scene array.');
  }

  const existed = fs.existsSync(target.filePath);
  if (existed && options.overwrite !== true) {
    throw new Error('Target scene already exists: ' + target.projectRelative);
  }

  fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
  const persisted = await persistSceneAsset(target, content, existed);

  const fileExists = fs.existsSync(target.filePath);
  const info = queryAssetInfoOptional(target.dbUrl);
  if (!fileExists && !info) {
    throw new Error('Scene was not created: ' + target.projectRelative);
  }

  return {
    created: !existed,
    overwritten: existed && options.overwrite === true,
    method: persisted.method,
    result: persisted.result,
    dbUrl: target.dbUrl,
    path: target.projectRelative,
    sceneName: target.sceneName,
    fileExists: fileExists,
    info: info,
  };
}

module.exports = {
  SCENE_EXTENSION,
  normalizeSceneTarget,
  loadEmptySceneTemplate,
  saveSceneContent,
};
