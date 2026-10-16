'use strict';

// Cocos Creator 2.4 scene script for the Funplay MCP extension.
//
// This file is loaded by Cocos Creator as the package scene script declared in
// package.json ("scene-script": "scene.js"). It runs inside the scene process,
// where the engine is exposed as the global `cc` namespace.
//
// Every exported function is invoked from the extension main process through
// Editor.Scene.callSceneScript(packageName, method, payload, callback). The
// dispatcher below tolerates either (event, ...args) or (...args, event)
// argument ordering by locating the object that carries a `reply` function.

/* global cc, Editor */

var ccNamespace = null;
if (typeof cc !== 'undefined' && cc) {
  ccNamespace = cc;
} else if (typeof global !== 'undefined' && global.cc) {
  ccNamespace = global.cc;
} else if (typeof window !== 'undefined' && window.cc) {
  ccNamespace = window.cc;
} else {
  try {
    ccNamespace = require('cc');
  } catch (error) {
    ccNamespace = null;
  }
}

var { captureScriptExecution } = require('./lib/script-execution');

var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function getCC() {
  if (!ccNamespace) {
    throw new Error('The Cocos engine namespace (cc) is unavailable in the scene process.');
  }
  return ccNamespace;
}

function getScene() {
  var engine = getCC();
  var director = engine.director;
  var scene = director && director.getScene();
  if (!scene) {
    throw new Error('No active scene is loaded.');
  }
  return scene;
}

// Cocos Creator 2.4 stores components on the private `_components` array (the
// public `components` accessor does not exist on 2.4 nodes), and both
// `node.scale` and `node.rotation` are deprecated numeric 2D shims that spam
// "is deprecated since v2.1.0" warnings and return a Number instead of a Vec3.
// These helpers read the real 2.4 storage so no deprecation warnings fire.
function getNodeComponents(node) {
  if (!node) {
    return [];
  }
  if (Array.isArray(node._components)) {
    return node._components;
  }
  if (Array.isArray(node.components)) {
    return node.components;
  }
  return [];
}

function getNodeScale(node) {
  if (!node) {
    return null;
  }
  if (node._scale) {
    return vectorToObject(node._scale);
  }
  if (typeof node.scaleX === 'number') {
    return { x: node.scaleX, y: node.scaleY, z: 1 };
  }
  return null;
}

function getNodeEuler(node) {
  if (!node || !node.eulerAngles) {
    return null;
  }
  return vectorToObject(node.eulerAngles);
}

// node.name used to require an exact match, so patterns like '*Camera*' matched
// nothing. Wildcards are treated as a glob; a plain string is a substring test
// (both case-insensitive).
function buildNameMatcher(pattern) {
  var source = String(pattern);
  if (source.indexOf('*') === -1 && source.indexOf('?') === -1) {
    var needle = source.toLowerCase();
    return function (value) {
      return String(value).toLowerCase().indexOf(needle) !== -1;
    };
  }
  var out = '';
  for (var i = 0; i < source.length; i += 1) {
    var char = source[i];
    if (char === '*') {
      out += '.*';
    } else if (char === '?') {
      out += '.';
    } else if ('\\^$.|+()[]{}'.indexOf(char) !== -1) {
      out += '\\' + char;
    } else {
      out += char;
    }
  }
  var regex = new RegExp('^' + out + '$', 'i');
  return function (value) {
    return regex.test(String(value));
  };
}

function getComponentNames(node) {
  return getNodeComponents(node)
    .map(function (component) { return component && component.constructor && component.constructor.name; })
    .filter(Boolean);
}

function getSerializableKeys(target) {
  var keys = new Set();
  var current = target;
  var depth = 0;
  while (current && current !== Object.prototype && depth < 4) {
    Object.keys(current).forEach(function (key) {
      if (key.charAt(0) !== '_') {
        keys.add(key);
      }
    });
    current = Object.getPrototypeOf(current);
    depth += 1;
  }
  return Array.from(keys);
}

function getNodePath(node) {
  var names = [];
  var current = node;
  var scene = getScene();
  while (current && current !== scene) {
    names.unshift(current.name);
    current = current.parent;
  }
  return names.join('/');
}

function vectorToObject(value) {
  if (!value) {
    return null;
  }
  return { x: value.x, y: value.y, z: value.z };
}

function quatToObject(value) {
  if (!value) {
    return null;
  }
  return { x: value.x, y: value.y, z: value.z, w: value.w };
}

function colorToObject(value) {
  if (!value) {
    return null;
  }
  return { r: value.r, g: value.g, b: value.b, a: value.a };
}

function summarizeNode(node, depth, maxDepth, includeComponents, includeInactive) {
  if (!includeInactive && !node.active) {
    return null;
  }

  var summary = {
    name: node.name,
    path: getNodePath(node),
    uuid: node.uuid,
    active: Boolean(node.active),
    layer: node.layer,
    position: vectorToObject(node.position),
    rotation: getNodeEuler(node),
    scale: getNodeScale(node),
  };

  if (includeComponents) {
    summary.components = getComponentNames(node);
  }

  if (depth < maxDepth) {
    var children = [];
    node.children.forEach(function (child) {
      var childSummary = summarizeNode(child, depth + 1, maxDepth, includeComponents, includeInactive);
      if (childSummary) {
        children.push(childSummary);
      }
    });
    summary.children = children;
  } else {
    summary.childCount = node.children.length;
  }

  return summary;
}

function walkNodes(visitor, node) {
  visitor(node);
  node.children.forEach(function (child) {
    walkNodes(visitor, child);
  });
}

function findNodeByPath(nodePath) {
  if (!nodePath) {
    return null;
  }

  var segments = String(nodePath)
    .split('/')
    .map(function (segment) { return segment.trim(); })
    .filter(Boolean);

  var current = getScene();
  if (segments[0] === current.name) {
    segments.shift();
  }

  for (var i = 0; i < segments.length; i += 1) {
    var segment = segments[i];
    current = current.children.find(function (child) { return child.name === segment; });
    if (!current) {
      return null;
    }
  }
  return current;
}

function findNodeByUuid(uuid) {
  if (!uuid) {
    return null;
  }
  var match = null;
  walkNodes(function (node) {
    if (!match && node.uuid === uuid) {
      match = node;
    }
  }, getScene());
  return match;
}

function findNodeByName(name) {
  if (!name) {
    return null;
  }
  var match = null;
  walkNodes(function (node) {
    if (!match && node.name === name) {
      match = node;
    }
  }, getScene());
  return match;
}

function findNode(input) {
  input = input || {};
  return findNodeByUuid(input.uuid) || findNodeByPath(input.path) || findNodeByName(input.name);
}

function resolveComponentClass(componentName) {
  if (!componentName) {
    return null;
  }
  if (typeof componentName !== 'string') {
    return componentName;
  }

  var engine = getCC();
  var js = engine.js;
  var direct = js && typeof js.getClassByName === 'function' ? js.getClassByName(componentName) : null;
  if (direct) {
    return direct;
  }

  var candidates = [componentName, 'cc.' + componentName];
  for (var i = 0; i < candidates.length; i += 1) {
    var found = js && typeof js.getClassByName === 'function' ? js.getClassByName(candidates[i]) : null;
    if (found) {
      return found;
    }
  }

  // Fall back to the engine namespace (for example Label -> cc.Label).
  var simple = componentName.replace(/^cc\./, '');
  if (engine[simple]) {
    return engine[simple];
  }
  return null;
}

function findComponent(node, options) {
  options = options || {};
  if (!node) {
    return null;
  }

  if (Number.isInteger(options.index)) {
    return getNodeComponents(node)[options.index] || null;
  }

  if (options.componentName) {
    var exact = getNodeComponents(node).find(function (component) {
      return component && component.constructor && component.constructor.name === options.componentName;
    });
    if (exact) {
      return exact;
    }
    var componentClass = resolveComponentClass(options.componentName);
    if (componentClass) {
      return node.getComponent(componentClass);
    }
  }
  return null;
}

// Scene-wide lookup used by queries such as list_cameras.
function findComponentsByClass(componentClass) {
  var results = [];
  if (!componentClass) {
    return results;
  }
  walkNodes(function (node) {
    if (node === getScene()) {
      return;
    }
    var component = node.getComponent(componentClass);
    if (component) {
      results.push(component);
    }
  }, getScene());
  return results;
}

function splitPropertyPath(propertyPath) {
  return String(propertyPath || '')
    .split('.')
    .map(function (segment) { return segment.trim(); })
    .filter(Boolean);
}

function getValueByPath(target, propertyPath) {
  var segments = splitPropertyPath(propertyPath);
  var current = target;
  for (var i = 0; i < segments.length; i += 1) {
    if (current == null) {
      return undefined;
    }
    current = current[segments[i]];
  }
  return current;
}

// Cocos Creator 2.4 stores declared property defaults in the class attribute
// table, and `__initProps__` copies them onto every instance as own properties
// (there is no prototype default to fall back to). So a reset must read the
// class default and write it back through the public setter, which keeps engine
// side effects (renderer camera, clipping planes, ...) in sync. Building a
// throwaway instance with `__initProps__` yields the defaults as public values.
function readClassDefaults(instance) {
  var cls = instance && instance.constructor;
  var proto = cls && cls.prototype;
  if (!proto || typeof proto.__initProps__ !== 'function') {
    return null;
  }
  // Object.create keeps the class prototype in the chain so accessor
  // properties (fov, clearFlags, ...) resolve through their public getters.
  var temp = Object.create(proto);
  try {
    proto.__initProps__.call(temp, cls);
  } catch (error) {
    return null;
  }
  return temp;
}

function resolveDefaultValue(defaults, key) {
  var candidates = [key, '_' + key];
  for (var i = 0; i < candidates.length; i += 1) {
    if (candidates[i] in defaults) {
      try {
        return { found: true, value: defaults[candidates[i]] };
      } catch (error) {
        // A getter may need live runtime state a bare instance lacks; try the backing field.
      }
    }
  }
  return { found: false };
}

function resetValueByPath(target, propertyPath) {
  var segments = splitPropertyPath(propertyPath);
  if (!segments.length) {
    throw new Error('propertyPath is required.');
  }
  var current = target;
  for (var i = 0; i < segments.length - 1; i += 1) {
    current = current[segments[i]];
    if (current == null) {
      return { applied: false, reason: 'path-not-found' };
    }
  }
  if (current == null) {
    return { applied: false, reason: 'path-not-found' };
  }
  var key = segments[segments.length - 1];
  var defaults = readClassDefaults(current);
  if (!defaults) {
    return { applied: false, reason: 'class-defaults-unavailable' };
  }
  var resolved = resolveDefaultValue(defaults, key);
  if (!resolved.found) {
    return { applied: false, reason: 'unknown-property' };
  }
  try {
    current[key] = resolved.value;
  } catch (error) {
    return { applied: false, reason: 'read-only-property' };
  }
  return { applied: true };
}

function getOrAddComponent(node, componentClass) {
  return node.getComponent(componentClass) || node.addComponent(componentClass);
}

function configureNodeBasics(node, options) {
  options = options || {};
  if (options.position) {
    node.setPosition(options.position.x || 0, options.position.y || 0, options.position.z || 0);
  }
  if (options.scale) {
    node.setScale(options.scale.x || 1, options.scale.y || 1, options.scale.z || 1);
  }
  if (options.eulerAngles && typeof node.setRotationFromEuler === 'function') {
    node.setRotationFromEuler(
      options.eulerAngles.x || 0,
      options.eulerAngles.y || 0,
      options.eulerAngles.z || 0
    );
  }
  if (typeof options.active === 'boolean') {
    node.active = options.active;
  }
}

// 2.4 keeps content size on the node itself (there is no UITransform component).
function configureContentSize(node, options) {
  options = options || {};
  var width = Number.isFinite(options.width) ? options.width : 160;
  var height = Number.isFinite(options.height) ? options.height : 60;
  if (typeof node.setContentSize === 'function') {
    node.setContentSize(width, height);
  } else {
    node.width = width;
    node.height = height;
  }
  if (options.anchor && typeof node.setAnchorPoint === 'function') {
    var ax = options.anchor.x === undefined ? 0.5 : options.anchor.x;
    var ay = options.anchor.y === undefined ? 0.5 : options.anchor.y;
    node.setAnchorPoint(ax, ay);
  }
  return node;
}

function parseColor(value, fallback) {
  var engine = getCC();
  var Color = engine.Color;
  if (!value) {
    return fallback;
  }
  if (typeof value === 'string') {
    var normalized = value.charAt(0) === '#' ? value.slice(1) : value;
    var number = Number.parseInt(normalized.length === 6 ? normalized + 'ff' : normalized, 16);
    if (Number.isFinite(number)) {
      return new Color((number >> 24) & 255, (number >> 16) & 255, (number >> 8) & 255, number & 255);
    }
  }
  return new Color(
    value.r === undefined ? 255 : value.r,
    value.g === undefined ? 255 : value.g,
    value.b === undefined ? 255 : value.b,
    value.a === undefined ? 255 : value.a
  );
}

// Cocos Creator 2.4 camera property names differ from 3.x: 2.4 exposes `ortho`
// (a boolean) instead of a projection enum, `orthoSize`/`nearClip`/`farClip`
// instead of orthoHeight/near/far, `cullingMask` instead of visibility, and
// `depth` instead of priority. These are the names applied here.
var CAMERA_PROPERTY_NAMES = [
  'depth',
  'cullingMask',
  'clearFlags',
  'ortho',
  'orthoSize',
  'fov',
  'nearClip',
  'farClip',
  'zoomRatio',
];

// cc.Camera.ClearFlags is a bitfield (COLOR=1, DEPTH=2, STENCIL=4). Accept a
// number, an array of names, or a '|'/comma/space separated string of names.
function resolveCameraClearFlags(value, engine) {
  if (typeof value === 'number') {
    return value;
  }
  var flags = engine.Camera && (engine.Camera.ClearFlags || engine.Camera.ClearFlag);
  if (!flags) {
    throw new Error('cc.Camera.ClearFlags is unavailable.');
  }
  var names = Array.isArray(value) ? value : String(value || '').split(/[|,\s]+/);
  return names.filter(Boolean).reduce(function (acc, name) {
    var key = String(name).trim().toUpperCase().replace(/^CAMERA\./, '').replace(/^CLEARFLAGS\./, '');
    if (typeof flags[key] !== 'number') {
      throw new Error('Unknown camera clearFlags entry: ' + name);
    }
    return acc | flags[key];
  }, 0);
}

function applyCameraProperties(camera, options, engine) {
  CAMERA_PROPERTY_NAMES.forEach(function (key) {
    if (options[key] === undefined) {
      return;
    }
    camera[key] = key === 'clearFlags' ? resolveCameraClearFlags(options[key], engine) : options[key];
  });
  return camera;
}

function summarizeCamera(camera) {
  return {
    node: camera.node ? getNodePath(camera.node) : '',
    uuid: camera.node ? camera.node.uuid : '',
    enabled: Boolean(camera.enabled),
    depth: camera.depth,
    cullingMask: camera.cullingMask,
    clearFlags: camera.clearFlags,
    ortho: Boolean(camera.ortho),
    orthoSize: camera.orthoSize,
    fov: camera.fov,
    nearClip: camera.nearClip,
    farClip: camera.farClip,
    zoomRatio: camera.zoomRatio,
  };
}

function plain(value, depth, seen) {
  depth = depth || 0;
  seen = seen || new WeakSet();
  var engine = getCC();

  if (value == null) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof engine.Node) {
    return {
      name: value.name,
      path: getNodePath(value),
      uuid: value.uuid,
      active: Boolean(value.active),
      components: getComponentNames(value),
    };
  }
  if (engine.Vec3 && value instanceof engine.Vec3) {
    return vectorToObject(value);
  }
  if (engine.Quat && value instanceof engine.Quat) {
    return quatToObject(value);
  }
  if (engine.Color && value instanceof engine.Color) {
    return colorToObject(value);
  }
  if (Array.isArray(value)) {
    if (depth >= 5) {
      return '[Array(' + value.length + ')]';
    }
    return value.map(function (item) { return plain(item, depth + 1, seen); });
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    if (depth >= 5) {
      return '[' + (value.constructor && value.constructor.name ? value.constructor.name : 'Object') + ']';
    }
    var output = {};
    Object.keys(value).forEach(function (key) {
      try {
        output[key] = plain(value[key], depth + 1, seen);
      } catch (error) {
        output[key] = '[Unserializable: ' + error.message + ']';
      }
    });
    return output;
  }
  return String(value);
}

async function executeUserCode(code, args, scriptConsole) {
  var engine = getCC();
  var scene = getScene();
  var Runner = new AsyncFunction('require', 'cc', 'Editor', 'scene', 'director', 'args', 'console', [
    'const module = { exports: {} };',
    'const exports = module.exports;',
    code,
    'if (typeof run === "function") { return await run({ cc, Editor, scene, director, args, console }); }',
    'if (typeof module.exports === "function") { return await module.exports({ cc, Editor, scene, director, args, console }); }',
    'if (module.exports && typeof module.exports.run === "function") { return await module.exports.run({ cc, Editor, scene, director, args, console }); }',
  ].join('\n'));
  return await Runner(require, engine, typeof Editor !== 'undefined' ? Editor : undefined, scene, engine.director, args || {}, scriptConsole);
}

// ---------------------------------------------------------------------------
// Scene serialization
//
// Cocos Creator 2.4 has no editor-side scene serializer exposed to extensions,
// but the scene renderer owns the live graph and Editor.serialize() can turn it
// back into the on-disk .fire document: a cc.SceneAsset header followed by the
// scene itself, with every __id__ shifted by one for the extra header entry.
// ---------------------------------------------------------------------------

function serializeSceneDocument() {
  if (typeof Editor === 'undefined' || !Editor || typeof Editor.serialize !== 'function') {
    throw new Error('Editor.serialize is unavailable in this scene context.');
  }
  var scene = getScene();
  var list = JSON.parse(Editor.serialize(scene, { stringify: true, minify: false }));

  function shiftIds(value) {
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        shiftIds(value[i]);
      }
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    Object.keys(value).forEach(function (key) {
      var entry = value[key];
      if (key === '__id__' && typeof entry === 'number') {
        value[key] = entry + 1;
      } else {
        shiftIds(entry);
      }
    });
  }

  list.forEach(shiftIds);
  list.unshift({ __type__: 'cc.SceneAsset', _name: '', _objFlags: 0, _native: '', scene: { __id__: 1 } });

  return {
    uuid: scene.uuid,
    sceneName: scene.name,
    content: JSON.stringify(list, null, 2),
  };
}

// ---------------------------------------------------------------------------
// Method implementations
// ---------------------------------------------------------------------------

var implementations = {
  async getSceneInfo(options) {
    options = options || {};
    var maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 2;
    var includeComponents = options.includeComponents !== false;
    var scene = getScene();
    return {
      sceneName: scene.name,
      uuid: scene.uuid,
      childCount: scene.children.length,
      nodes: scene.children
        .map(function (child) { return summarizeNode(child, 1, Math.max(1, maxDepth), includeComponents, true); })
        .filter(Boolean),
    };
  },

  async getHierarchy(options) {
    options = options || {};
    var scene = getScene();
    // Always answer with the same shape (the traversal root's children) so
    // callers never have to branch on whether rootPath was supplied.
    var root = options.rootPath ? findNodeByPath(options.rootPath) : scene;
    if (!root) {
      throw new Error('Node not found: ' + options.rootPath);
    }
    var maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 3;
    var includeComponents = options.includeComponents !== false;
    var includeInactive = options.includeInactive !== false;

    return {
      sceneName: scene.name,
      rootPath: root === scene ? '' : getNodePath(root),
      nodes: root.children
        .map(function (child) { return summarizeNode(child, 1, Math.max(1, maxDepth), includeComponents, includeInactive); })
        .filter(Boolean),
    };
  },

  async inspectNode(options) {
    options = options || {};
    var node = findNode(options);
    if (!node) {
      throw new Error('Target node was not found.');
    }
    return {
      name: node.name,
      path: getNodePath(node),
      uuid: node.uuid,
      active: Boolean(node.active),
      layer: node.layer,
      siblingIndex: typeof node.getSiblingIndex === 'function' ? node.getSiblingIndex() : undefined,
      position: vectorToObject(node.position),
      rotation: getNodeEuler(node),
      scale: getNodeScale(node),
      width: node.width,
      height: node.height,
      children: node.children.map(function (child) {
        return { name: child.name, path: getNodePath(child), uuid: child.uuid };
      }),
      components: getComponentNames(node),
    };
  },

  async findNodes(options) {
    options = options || {};
    var name = options.name ? String(options.name) : '';
    var nameMatcher = name ? buildNameMatcher(name) : null;
    var pathContains = options.pathContains ? String(options.pathContains) : '';
    var component = options.component ? String(options.component) : '';
    var includeInactive = options.includeInactive !== false;
    var results = [];

    walkNodes(function (node) {
      if (node === getScene() || (!includeInactive && !node.active)) {
        return;
      }
      var nodePath = getNodePath(node);
      var components = getComponentNames(node);
      if (nameMatcher && !nameMatcher(node.name)) {
        return;
      }
      if (pathContains && nodePath.indexOf(pathContains) === -1) {
        return;
      }
      if (component && components.indexOf(component) === -1) {
        return;
      }
      results.push({ name: node.name, path: nodePath, uuid: node.uuid, active: Boolean(node.active), components: components });
    }, getScene());

    return { count: results.length, nodes: results.slice(0, 200) };
  },

  async createNode(options) {
    options = options || {};
    var engine = getCC();
    var name = String(options.name || '').trim();
    if (!name) {
      throw new Error('name is required.');
    }
    var parent = options.parentPath ? findNodeByPath(options.parentPath) : getScene();
    if (!parent) {
      throw new Error('Parent not found: ' + options.parentPath);
    }
    var node = new engine.Node(name);
    node.parent = parent;
    configureNodeBasics(node, options);
    return { created: true, name: node.name, path: getNodePath(node), uuid: node.uuid };
  },

  async deleteNode(options) {
    var node = findNode(options || {});
    if (!node) {
      throw new Error('Target node was not found.');
    }
    var targetPath = getNodePath(node);
    var uuid = node.uuid;
    node.removeFromParent();
    node.destroy();
    return { deleted: true, path: targetPath, uuid: uuid };
  },

  async setNodeTransform(options) {
    options = options || {};
    var node = findNode(options);
    if (!node) {
      throw new Error('Target node was not found.');
    }
    configureNodeBasics(node, options);
    return {
      updated: true,
      name: node.name,
      path: getNodePath(node),
      active: Boolean(node.active),
      position: vectorToObject(node.position),
      rotation: getNodeEuler(node),
      scale: getNodeScale(node),
    };
  },

  async listComponents(options) {
    var node = findNode(options || {});
    if (!node) {
      throw new Error('Target node was not found.');
    }
    return {
      node: { name: node.name, path: getNodePath(node), uuid: node.uuid },
      components: getNodeComponents(node).map(function (component, index) {
        return {
          index: index,
          name: component && component.constructor ? component.constructor.name : 'UnknownComponent',
          enabled: typeof component.enabled === 'boolean' ? component.enabled : undefined,
          keys: getSerializableKeys(component).slice(0, 50),
        };
      }),
    };
  },

  async addComponent(options) {
    options = options || {};
    var node = findNode(options);
    if (!node) {
      throw new Error('Target node was not found.');
    }
    var componentClass = resolveComponentClass(options.componentName);
    if (!componentClass) {
      throw new Error('Component class not found: ' + options.componentName);
    }
    var component = node.addComponent(componentClass);
    return {
      added: true,
      node: getNodePath(node),
      component: component.constructor ? component.constructor.name : options.componentName,
      index: getNodeComponents(node).indexOf(component),
    };
  },

  async removeComponent(options) {
    var node = findNode(options || {});
    if (!node) {
      throw new Error('Target node was not found.');
    }
    var component = findComponent(node, options);
    if (!component) {
      throw new Error('Target component was not found.');
    }
    var componentName = component.constructor ? component.constructor.name : 'UnknownComponent';
    node.removeComponent(component);
    return { removed: true, node: getNodePath(node), component: componentName };
  },

  async inspectComponent(options) {
    var node = findNode(options || {});
    if (!node) {
      throw new Error('Target node was not found.');
    }
    var component = findComponent(node, options);
    if (!component) {
      throw new Error('Target component was not found.');
    }
    return {
      node: { name: node.name, path: getNodePath(node), uuid: node.uuid },
      component: {
        name: component.constructor ? component.constructor.name : 'UnknownComponent',
        enabled: typeof component.enabled === 'boolean' ? component.enabled : undefined,
        data: plain(component),
      },
    };
  },

  async setComponentProperty(options) {
    options = options || {};
    var node = findNode(options);
    if (!node) {
      throw new Error('Target node was not found.');
    }
    var component = findComponent(node, options);
    if (!component) {
      throw new Error('Target component was not found.');
    }
    var segments = String(options.propertyPath || '')
      .split('.')
      .map(function (segment) { return segment.trim(); })
      .filter(Boolean);
    if (!segments.length) {
      throw new Error('propertyPath is required.');
    }
    var current = component;
    for (var i = 0; i < segments.length - 1; i += 1) {
      var segment = segments[i];
      if (current[segment] == null || typeof current[segment] !== 'object') {
        current[segment] = {};
      }
      current = current[segment];
    }
    current[segments[segments.length - 1]] = options.value;

    var readBack = component;
    for (var j = 0; j < segments.length; j += 1) {
      readBack = readBack == null ? undefined : readBack[segments[j]];
    }
    return {
      updated: true,
      node: getNodePath(node),
      component: component.constructor ? component.constructor.name : 'UnknownComponent',
      propertyPath: options.propertyPath,
      value: plain(readBack),
    };
  },

  async invokeComponentMethod(options) {
    options = options || {};
    var node = findNode(options);
    if (!node) {
      throw new Error('Target node was not found.');
    }
    var component = findComponent(node, options);
    if (!component) {
      throw new Error('Target component was not found.');
    }
    var methodName = String(options.methodName || '').trim();
    if (!methodName || typeof component[methodName] !== 'function') {
      throw new Error('Component method not found: ' + methodName);
    }
    var callArgs = Array.isArray(options.args) ? options.args : [];
    var result = component[methodName].apply(component, callArgs);
    if (result && typeof result.then === 'function') {
      result = await result;
    }
    return {
      invoked: true,
      node: getNodePath(node),
      component: component.constructor ? component.constructor.name : 'UnknownComponent',
      methodName: methodName,
      result: plain(result),
    };
  },

  async resetComponentProperty(options) {
    options = options || {};
    var node = findNode(options);
    if (!node) {
      throw new Error('Target node was not found.');
    }
    var component = findComponent(node, options);
    if (!component) {
      throw new Error('Target component was not found.');
    }
    var resetResult = resetValueByPath(component, options.propertyPath);
    if (!resetResult.applied) {
      throw new Error(
        'Unable to reset property "' + options.propertyPath + '" (' + (resetResult.reason || 'unknown') + ').'
      );
    }
    return {
      reset: true,
      node: getNodePath(node),
      component: component.constructor ? component.constructor.name : 'UnknownComponent',
      propertyPath: options.propertyPath,
      value: plain(getValueByPath(component, options.propertyPath)),
    };
  },

  async createCanvas(options) {
    options = options || {};
    var engine = getCC();
    var parent = options.parentPath ? findNodeByPath(options.parentPath) : getScene();
    if (!parent) {
      throw new Error('Parent not found: ' + options.parentPath);
    }
    var node = new engine.Node(options.name || 'Canvas');
    node.parent = parent;
    configureNodeBasics(node, options);
    getOrAddComponent(node, engine.Canvas);
    configureContentSize(node, {
      width: Number.isFinite(options.width) ? options.width : 960,
      height: Number.isFinite(options.height) ? options.height : 640,
    });
    return { created: true, name: node.name, path: getNodePath(node), uuid: node.uuid, components: getComponentNames(node) };
  },

  async createLabel(options) {
    options = options || {};
    var engine = getCC();
    var parent = options.parentPath ? findNodeByPath(options.parentPath) : getScene();
    if (!parent) {
      throw new Error('Parent not found: ' + options.parentPath);
    }
    var node = new engine.Node(options.name || 'Label');
    node.parent = parent;
    configureNodeBasics(node, options);
    configureContentSize(node, options);
    var label = getOrAddComponent(node, engine.Label);
    label.string = options.text || 'Label';
    label.fontSize = Number.isFinite(options.fontSize) ? options.fontSize : 32;
    label.lineHeight = Number.isFinite(options.lineHeight) ? options.lineHeight : label.fontSize + 8;
    if (options.color) {
      label.color = parseColor(options.color, engine.Color.WHITE);
    }
    return { created: true, path: getNodePath(node), uuid: node.uuid, text: label.string };
  },

  async createButton(options) {
    options = options || {};
    var engine = getCC();
    var parent = options.parentPath ? findNodeByPath(options.parentPath) : getScene();
    if (!parent) {
      throw new Error('Parent not found: ' + options.parentPath);
    }
    var width = Number.isFinite(options.width) ? options.width : 180;
    var height = Number.isFinite(options.height) ? options.height : 64;

    var node = new engine.Node(options.name || 'Button');
    node.parent = parent;
    configureNodeBasics(node, options);
    configureContentSize(node, { width: width, height: height });
    var sprite = getOrAddComponent(node, engine.Sprite);
    sprite.color = parseColor(options.backgroundColor, new engine.Color(64, 96, 255, 255));
    var button = getOrAddComponent(node, engine.Button);
    button.target = node;

    var labelNode = new engine.Node(options.labelName || 'Label');
    labelNode.parent = node;
    configureContentSize(labelNode, { width: width, height: height });
    var label = getOrAddComponent(labelNode, engine.Label);
    label.string = options.text || 'Button';
    label.fontSize = Number.isFinite(options.fontSize) ? options.fontSize : 28;
    label.lineHeight = Number.isFinite(options.lineHeight) ? options.lineHeight : label.fontSize + 8;
    label.color = parseColor(options.textColor, engine.Color.WHITE);

    return {
      created: true,
      path: getNodePath(node),
      uuid: node.uuid,
      labelPath: getNodePath(labelNode),
      components: getComponentNames(node),
    };
  },

  async createSprite(options) {
    options = options || {};
    var engine = getCC();
    var parent = options.parentPath ? findNodeByPath(options.parentPath) : getScene();
    if (!parent) {
      throw new Error('Parent not found: ' + options.parentPath);
    }
    var node = new engine.Node(options.name || 'Sprite');
    node.parent = parent;
    configureNodeBasics(node, options);
    configureContentSize(node, options);
    var sprite = getOrAddComponent(node, engine.Sprite);
    if (options.color) {
      sprite.color = parseColor(options.color, engine.Color.WHITE);
    }
    if (options.spriteFrameUuid) {
      sprite.spriteFrame = await loadAssetByUuid(options.spriteFrameUuid);
    }
    return { created: true, path: getNodePath(node), uuid: node.uuid, components: getComponentNames(node) };
  },

  async listCameras() {
    var engine = getCC();
    var cameras = findComponentsByClass(engine.Camera);
    return { count: cameras.length, cameras: cameras.map(summarizeCamera) };
  },

  async createCamera(options) {
    options = options || {};
    var engine = getCC();
    var parent = options.parentPath ? findNodeByPath(options.parentPath) : getScene();
    if (!parent) {
      throw new Error('Parent not found: ' + options.parentPath);
    }
    var node = new engine.Node(options.name || 'Camera');
    node.parent = parent;
    configureNodeBasics(node, options);
    var camera = getOrAddComponent(node, engine.Camera);
    applyCameraProperties(camera, options, engine);
    return { created: true, path: getNodePath(node), uuid: node.uuid, camera: summarizeCamera(camera) };
  },

  async setCameraProperties(options) {
    options = options || {};
    var node = findNode(options);
    if (!node) {
      throw new Error('Target camera node was not found.');
    }
    var engine = getCC();
    var camera = node.getComponent(engine.Camera);
    if (!camera) {
      throw new Error('Camera component was not found on the target node.');
    }
    applyCameraProperties(camera, options, engine);
    return { updated: true, node: getNodePath(node), uuid: node.uuid, camera: summarizeCamera(camera) };
  },

  async serializeScene() {
    return serializeSceneDocument();
  },

  async executeCode(options) {
    options = options || {};
    var code = String(options.code || '');
    if (!code.trim()) {
      throw new Error('code is required.');
    }
    var run = async function (scriptConsole) {
      var result = await executeUserCode(code, options.args || {}, scriptConsole);
      return { ok: true, result: plain(result), sceneName: getScene().name };
    };
    return options.captureActivity
      ? captureScriptExecution(run, { context: 'scene', targetConsole: console })
      : run(console);
  },
};

function loadAssetByUuid(uuid) {
  return new Promise(function (resolve, reject) {
    var engine = getCC();
    if (!engine.assetManager || typeof engine.assetManager.loadAny !== 'function') {
      reject(new Error('cc.assetManager.loadAny is unavailable.'));
      return;
    }
    engine.assetManager.loadAny(uuid, function (error, asset) {
      if (error) {
        reject(error);
        return;
      }
      resolve(asset);
    });
  });
}

// ---------------------------------------------------------------------------
// Dispatcher: adapt argument ordering and reply through the scene script event.
// ---------------------------------------------------------------------------

Object.keys(implementations).forEach(function (name) {
  module.exports[name] = function () {
    var args = Array.prototype.slice.call(arguments);
    var event = null;
    var rest = [];
    for (var i = 0; i < args.length; i += 1) {
      if (args[i] && typeof args[i].reply === 'function') {
        event = args[i];
      } else {
        rest.push(args[i]);
      }
    }
    var payload = rest.length && rest[0] != null ? rest[0] : {};

    Promise.resolve()
      .then(function () { return implementations[name](payload); })
      .then(function (result) {
        if (event) {
          event.reply(null, result);
        }
      }, function (error) {
        if (event) {
          event.reply(error instanceof Error ? error : new Error(String(error)));
        } else {
          console.error('[funplay-cocos-mcp] scene script "' + name + '" failed:', error);
        }
      });
  };
});
