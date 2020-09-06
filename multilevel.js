const MLT = {
  SCOPE: "multilevel-tokens",
  SETTING_TINT_COLOR: "tintcolor",
  SETTING_ANIMATE_TELEPORTS: "animateteleports",
  SETTING_AUTO_TARGET: "autotarget",
  SETTING_AUTO_CHAT_BUBBLE: "autochatbubble",
  SETTING_CLONE_MODULE_FLAGS: "clonemoduleflags",
  DEFAULT_TINT_COLOR: "#808080",
  TAG_SOURCE: "@source:",
  TAG_TARGET: "@target:",
  TAG_IN: "@in:",
  TAG_OUT: "@out:",
  TAG_INOUT: "@inout:",
  TAG_LEVEL: "@level:",
  TAG_LOCAL_PREFIX: "!",
  FLAG_SOURCE_SCENE: "sscene",
  FLAG_SOURCE_TOKEN: "stoken",
  FLAG_SOURCE_REGION: "srect",
  FLAG_TARGET_REGION: "trect",
  REPLICATED_UPDATE: "mlt_bypass",
  LOG_PREFIX: "Multilevel Tokens | ",
  TOKEN_STAIRS: "@stairs",
};

class MltRequestBatch {
  constructor() {
    this._scenes = {};
    this._extraActions = [];
  }

  createToken(scene, data) {
    this._scene(scene).create.push(data);
  }

  updateToken(scene, data, animate=true) {
    (animate ? this._scene(scene).updateAnimated : this._scene(scene).updateInstant).push(data);
  }

  updateDrawing(scene, data) {
    this._scene(scene).updateDrawing.push(data);
  }

  deleteToken(scene, id) {
    this._scene(scene).delete.push(id);
  }

  extraAction(f) {
    this._extraActions.push(f);
  }

  _scene(scene) {
    if (!(scene._id in this._scenes)) {
      this._scenes[scene._id] = {
        create: [],
        updateAnimated: [],
        updateInstant: [],
        updateDrawing: [],
        delete: []};
    }
    return this._scenes[scene._id];
  }
}

class MultilevelTokens {
  constructor() {
    game.settings.register(MLT.SCOPE, MLT.SETTING_TINT_COLOR, {
      name: "Tint color for cloned tokens",
      hint: "Extra tint color applied to cloned tokens in target regions. Should be a hex color code.",
      scope: "world",
      config: true,
      type: String,
      default: MLT.DEFAULT_TINT_COLOR,
      onChange: this.refreshAll.bind(this),
    });
    game.settings.register(MLT.SCOPE, MLT.SETTING_AUTO_TARGET, {
      name: "Auto-sync player targets",
      hint: "If checked, targeting or detargeting a token will also target or detarget its clones (or originals). Turn this off if it interferes with things.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
    game.settings.register(MLT.SCOPE, MLT.SETTING_AUTO_CHAT_BUBBLE, {
      name: "Auto-sync chat bubbles",
      hint: "If checked, chat bubbles for a token will also be shown on its clones (or originals).",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
    game.settings.register(MLT.SCOPE, MLT.SETTING_ANIMATE_TELEPORTS, {
      name: "Animate teleports",
      hint: "If checked, tokens teleporting to the same scene will move to the new location with an animation rather than instantly.",
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });
    // TODO: maybe be necessary to decide this on a module-by-module basis. Could provide a way to let the user decide,
    // and / or just bake in defaults for known cases where it matters.
    game.settings.register(MLT.SCOPE, MLT.SETTING_CLONE_MODULE_FLAGS, {
      name: "Clone token flags set by other modules",
      hint: "Modules can set custom flags on tokens for their own use. If checked, cloned tokens will inherit such flags from the original. Since the purpose of these flags depends on the module in question, I can't tell you what this option will do, but if cloned tokens are interacting poorly with some other module, you can try changing it.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
    Hooks.on("ready", this._onReady.bind(this));
    Hooks.on("createScene", this.refreshAll.bind(this));
    Hooks.on("updateScene", this._onUpdateScene.bind(this));
    Hooks.on("deleteScene", this.refreshAll.bind(this));
    Hooks.on("createDrawing", this._onCreateDrawing.bind(this));
    Hooks.on("preUpdateDrawing", this._onPreUpdateDrawing.bind(this));
    Hooks.on("updateDrawing", this._onUpdateDrawing.bind(this));
    Hooks.on("deleteDrawing", this._onDeleteDrawing.bind(this));
    Hooks.on("preCreateToken", this._onPreCreateToken.bind(this));
    Hooks.on("createToken", this._onCreateToken.bind(this));
    Hooks.on("preUpdateToken", this._onPreUpdateToken.bind(this));
    Hooks.on("updateToken", this._onUpdateToken.bind(this));
    Hooks.on("preDeleteToken", this._onPreDeleteToken.bind(this));
    Hooks.on("deleteToken", this._onDeleteToken.bind(this));
    Hooks.on("targetToken", this._onTargetToken.bind(this));
    Hooks.on("preCreateCombatant", this._onPreCreateCombatant.bind(this));
    Hooks.on("createChatMessage", this._onCreateChatMessage.bind(this));
    this._lastTeleport = {};
    this._asyncQueue = null;
    this._asyncCount = 0;
    console.log(MLT.LOG_PREFIX, "Initialized");
  }

  _rotate(cx, cy, x, y, degrees) {
    const r = degrees * Math.PI / 180;
    return [cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r),
            cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)];
  }

  _isUserGamemaster(userId) {
    const user = game.users.get(userId);
    return user ? user.role === CONST.USER_ROLES.GAMEMASTER : false;
  }

  _getActiveGamemasters() {
    return game.users
        .filter(user => user.active && user.role === CONST.USER_ROLES.GAMEMASTER)
        .map(user => user._id)
        .sort();
  }

  _isOnlyGamemaster() {
    if (!game.user.isGM) {
      return false;
    }
    const activeGamemasters = this._getActiveGamemasters();
    return activeGamemasters.length === 1 && activeGamemasters[0] === game.user._id;
  }

  _isPrimaryGamemaster() {
    // To ensure commands are only issued once, return true only if we are the
    // _first_ active GM.
    if (!game.user.isGM) {
      return false;
    }
    const activeGamemasters = this._getActiveGamemasters();
    return activeGamemasters.length > 0 && activeGamemasters[0] === game.user._id;
  }

  _isTaggedRegion(drawing, tags) {
    return (drawing.type === CONST.DRAWING_TYPES.RECTANGLE ||
            drawing.type === CONST.DRAWING_TYPES.ELLIPSE ||
            drawing.type === CONST.DRAWING_TYPES.POLYGON) &&
        this._isUserGamemaster(drawing.author) &&
        (tags.constructor === Array
            ? tags.some(t => drawing.text && drawing.text.startsWith(t))
            : drawing.text && drawing.text.startsWith(tags));
  }

  _getRegionTag(drawing, tag) {
    return this._isTaggedRegion(drawing, tag) ? drawing.text.substring(tag.length) : null;
  }

  _isReplicatedToken(token) {
    return token.flags && (MLT.SCOPE in token.flags) && (MLT.FLAG_SOURCE_TOKEN in token.flags[MLT.SCOPE]);
  }

  _isProperToken(token) {
    return !this._isReplicatedToken(token) && token.name !== MLT.TOKEN_STAIRS;
  }

  _getSourceSceneForReplicatedToken(scene, token) {
    return (MLT.FLAG_SOURCE_SCENE in token.flags[MLT.SCOPE])
        ? game.scenes.get(token.flags[MLT.SCOPE][MLT.FLAG_SOURCE_SCENE])
        : scene;
  }

  _getSourceTokenForReplicatedToken(scene, token) {
    const sourceScene = this._getSourceSceneForReplicatedToken(scene, token);
    return sourceScene && sourceScene.data.tokens.find(t => t._id === token.flags[MLT.SCOPE][MLT.FLAG_SOURCE_TOKEN]);
  }

  _getAllLinkedCanvasTokens(token) {
    return canvas.tokens.placeables.filter(t => {
      if (this._isReplicatedToken(token)) {
        return this._isReplicatedToken(t.data)
            ? t.data.flags[MLT.SCOPE][MLT.FLAG_SOURCE_SCENE] === token.flags[MLT.SCOPE][MLT.FLAG_SOURCE_SCENE] &&
              t.data.flags[MLT.SCOPE][MLT.FLAG_SOURCE_TOKEN] === token.flags[MLT.SCOPE][MLT.FLAG_SOURCE_TOKEN]
            : !(MLT.FLAG_SOURCE_SCENE in token.flags[MLT.SCOPE]) &&
            token.flags[MLT.SCOPE][MLT.FLAG_SOURCE_TOKEN] === t.data._id;
      } else {
        return this._isReplicatedToken(t.data) &&
            !(MLT.FLAG_SOURCE_SCENE in t.data.flags[MLT.SCOPE]) &&
            t.data.flags[MLT.SCOPE][MLT.FLAG_SOURCE_TOKEN] === token._id;
      }
    });
  }

  _isInvalidReplicatedToken(scene, token) {
    if (!scene.data.drawings.some(d => d._id === token.flags[MLT.SCOPE][MLT.FLAG_TARGET_REGION])) {
      return true;
    }
    const sourceScene = this._getSourceSceneForReplicatedToken(scene, token);
    if (!sourceScene) {
      return false;
    }
    return !sourceScene.data.drawings.some(d => d._id === token.flags[MLT.SCOPE][MLT.FLAG_SOURCE_REGION]) ||
           !sourceScene.data.tokens.some(t => t._id === token.flags[MLT.SCOPE][MLT.FLAG_SOURCE_TOKEN]);
  }

  _isReplicationForSourceToken(sourceScene, sourceToken, targetScene, targetToken) {
    return targetToken.flags[MLT.SCOPE][MLT.FLAG_SOURCE_TOKEN] === sourceToken._id &&
        (MLT.FLAG_SOURCE_SCENE in targetToken.flags[MLT.SCOPE]
            ? targetToken.flags[MLT.SCOPE][MLT.FLAG_SOURCE_SCENE] === sourceScene._id
            : sourceScene === targetScene);
  }

  _isReplicationForRegion(scene, region, targetScene, targetToken) {
    return (scene === targetScene && targetToken.flags[MLT.SCOPE][MLT.FLAG_TARGET_REGION] === region._id) ||
       (targetToken.flags[MLT.SCOPE][MLT.FLAG_SOURCE_REGION] === region._id &&
            (MLT.FLAG_SOURCE_SCENE in targetToken.flags[MLT.SCOPE]
                ? targetToken.flags[MLT.SCOPE][MLT.FLAG_SOURCE_SCENE] === scene._id
                : scene === targetScene));
  }

  _getTokenCentre(scene, token) {
    return {
      x: token.x + token.width * scene.data.grid / 2,
      y: token.y + token.height * scene.data.grid / 2
    };
  }

  _isTokenInRegion(scene, token, region) {
    let centre = this._getTokenCentre(scene, token);
    if (region.rotation) {
      const r = this._rotate(region.x + region.width / 2, region.y + region.height / 2,
                             centre.x, centre.y, -region.rotation);
      centre.x = r[0];
      centre.y = r[1];
    }

    const inBox = centre.x >= region.x && centre.x <= region.x + region.width &&
                  centre.y >= region.y && centre.y <= region.y + region.height;
    if (!inBox) {
      return false;
    }
    if (region.type === CONST.DRAWING_TYPES.RECTANGLE) {
      return true;
    }
    if (region.type === CONST.DRAWING_TYPES.ELLIPSE) {
      if (!region.width || !region.height) {
        return false;
      }
      const dx = region.x + region.width / 2 - centre.x;
      const dy = region.y + region.height / 2 - centre.y;
      return 4 * (dx * dx) / (region.width * region.width) + 4 * (dy * dy) / (region.height * region.height) <= 1;
    }
    if (region.type === CONST.DRAWING_TYPES.POLYGON) {
      const cx = centre.x - region.x;
      const cy = centre.y - region.y;
      let w = 0;
      for (let i0 = 0; i0 < region.points.length; ++i0) {
        let i1 = i0 + 1 === region.points.length ? 0 : i0 + 1;
        if (region.points[i0][1] <= cy && region.points[i1][1] > cy &&
            (region.points[i1][0] - region.points[i0][0]) * (cy - region.points[i0][1]) -
            (region.points[i1][1] - region.points[i0][1]) * (cx - region.points[i0][0]) > 0) {
          ++w;
        }
        if (region.points[i0][1] > cy && region.points[i1][1] <= cy &&
            (region.points[i1][0] - region.points[i0][0]) * (cy - region.points[i0][1]) -
            (region.points[i1][1] - region.points[i0][1]) * (cx - region.points[i0][0]) < 0) {
          --w;
        }
      }
      return w !== 0;
    }
    return false;
  }

  _isPointInToken(scene, point, containingToken) {
    return containingToken.x <= point.x && point.x <= containingToken.x + (containingToken.width * scene.data.grid) &&
           containingToken.y <= point.y && point.y <= containingToken.y + (containingToken.height * scene.data.grid);
  }

  _mapTokenPosition(sourceScene, token, sourceRegion, targetScene, targetRegion) {
    let tokenX = token.x + token.width * sourceScene.data.grid / 2;
    let tokenY = token.y + token.height * sourceScene.data.grid / 2;
    if (sourceRegion.rotation) {
      const r = this._rotate(sourceRegion.x + sourceRegion.width / 2, sourceRegion.y + sourceRegion.height / 2,
                             tokenX, tokenY, -sourceRegion.rotation);
      tokenX = r[0];
      tokenY = r[1];
    }

    let targetX = targetRegion.x +
        (tokenX - sourceRegion.x) * (targetRegion.width / sourceRegion.width);
    let targetY = targetRegion.y +
        (tokenY - sourceRegion.y) * (targetRegion.height / sourceRegion.height);
    if (targetRegion.rotation) {
      const r = this._rotate(targetRegion.x + targetRegion.width / 2, targetRegion.y + targetRegion.height / 2,
                             targetX, targetY, targetRegion.rotation);
      targetX = r[0];
      targetY = r[1];
    }
    return {
      x: targetX - token.width * targetScene.data.grid / 2,
      y: targetY - token.height * targetScene.data.grid / 2
    };
  }

  _getScaleFactor(sourceScene, sourceRegion, targetScene, targetRegion) {
    return Math.min((targetRegion.width / targetScene.data.grid) / (sourceRegion.width / sourceScene.data.grid),
                    (targetRegion.height / targetScene.data.grid) / (sourceRegion.height/ sourceScene.data.grid));
  }

  _getReplicatedTokenCreateData(sourceScene, token, sourceRegion, targetScene, targetRegion) {
    const targetPosition =
        this._mapTokenPosition(sourceScene, token, sourceRegion, targetScene, targetRegion);
    const targetScaleFactor = this._getScaleFactor(sourceScene, sourceRegion, targetScene, targetRegion);

    const tintRgb = token.tint ? hexToRGB(colorStringToHex(token.tint)) : [1., 1., 1.];
    const multRgb = hexToRGB(colorStringToHex(
        game.settings.get(MLT.SCOPE, MLT.SETTING_TINT_COLOR) || MLT.DEFAULT_TINT_COLOR));
    for (let i = 0; i < multRgb.length; ++i) {
      tintRgb[i] *= multRgb[i];
    }
    const cloneModuleFlags = game.settings.get(MLT.SCOPE, MLT.SETTING_CLONE_MODULE_FLAGS) || false;

    const data = duplicate(token);
    delete data._id;
    data.actorId = "";
    data.actorLink = false;
    data.vision = false;
    data.x = targetPosition.x;
    data.y = targetPosition.y;
    data.scale = data.scale ? data.scale * targetScaleFactor : targetScaleFactor;
    data.rotation += targetRegion.rotation - sourceRegion.rotation;
    data.tint = "#" + rgbToHex(tintRgb).toString(16);
    if (!data.flags || !cloneModuleFlags) {
      data.flags = {};
    }
    data.flags[MLT.SCOPE] = {};
    if (sourceScene !== targetScene) {
      data.flags[MLT.SCOPE][MLT.FLAG_SOURCE_SCENE] = sourceScene._id;
    }
    data.flags[MLT.SCOPE][MLT.FLAG_SOURCE_TOKEN] = token._id;
    data.flags[MLT.SCOPE][MLT.FLAG_SOURCE_REGION] = sourceRegion._id;
    data.flags[MLT.SCOPE][MLT.FLAG_TARGET_REGION] = targetRegion._id;
    return data;
  }

  _getReplicatedTokenUpdateData(sourceScene, sourceToken,  sourceRegion, targetScene, targetToken, targetRegion) {
    const data = this._getReplicatedTokenCreateData(sourceScene, sourceToken, sourceRegion, targetScene, targetRegion);
    data._id = targetToken._id;
    delete data.flags;
    return data;
  }

  _getLinkedRegionsByTag(scene, region, regionTag, resultTags) {
    const id = this._getRegionTag(region, regionTag);
    if (!id) {
      return [];
    }
    const tagMatch = resultTags.constructor === Array
        ? drawing => resultTags.some(t => this._getRegionTag(drawing, t) === id)
        : drawing => this._getRegionTag(drawing, resultTags) === id;
    if (id.startsWith(MLT.TAG_LOCAL_PREFIX)) {
      return scene.data.drawings
          .filter(d => d._id !== region._id && tagMatch(d))
          .map(result => [region, scene, result]);
    }
    return game.scenes.map(resultScene => resultScene.data.drawings
        .filter(d => (d._id !== region._id || scene !== resultScene) && tagMatch(d))
        .map(result => [region, resultScene, result])
    ).flat();
  }

  _getNumericallyAdjacentLevelRegions(scene, levelRegion) {
    const levelNumber = parseInt(this._getRegionTag(levelRegion, MLT.TAG_LEVEL));
    return scene.data.drawings.filter(d => {
      const otherNumber = parseInt(this._getRegionTag(d, MLT.TAG_LEVEL));
      return otherNumber == levelNumber + 1 || otherNumber == levelNumber - 1;
    });
  }

  _getTaggedRegionsContainingToken(scene, token, tags) {
    return scene.data.drawings
        .filter(drawing => this._isTaggedRegion(drawing, tags) &&
                           this._isTokenInRegion(scene, token, drawing));
  }

  _filterRegionsAndUpdateLastTeleport(token, inRegions) {
    let lastTeleport = this._lastTeleport[token._id];
    if (lastTeleport) {
      lastTeleport = lastTeleport.filter(id => inRegions.some(r => r._id === id));
      inRegions = inRegions.filter(r => !lastTeleport.includes(r._id));
      if (lastTeleport.length) {
        this._lastTeleport[token._id] = lastTeleport;
      } else {
        delete this._lastTeleport[token._id];
      }
    }
    return inRegions;
  }

  _getReplicatedTokensForSourceToken(sourceScene, sourceToken) {
    return game.scenes.map(scene => scene.data.tokens
        .filter(token => this._isReplicatedToken(token) &&
                         this._isReplicationForSourceToken(sourceScene, sourceToken, scene, token))
        .map(token => [scene, token])
    ).flat();
  }

  _getReplicatedTokensForRegion(scene, region) {
    const sourceTag = this._getRegionTag(region, MLT.TAG_SOURCE);
    const scenes = (sourceTag && sourceTag.startsWith(MLT.TAG_LOCAL_PREFIX)) ||
        this._isTaggedRegion(region, MLT.TAG_TARGET) ? [scene] : game.scenes;
    return scenes.map(s => s.data.tokens
        .filter(token => this._isReplicatedToken(token) &&
                         this._isReplicationForRegion(scene, region, s, token))
        .map(token => [s, token])
    ).flat();
  }

  _getTokensToReplicateForRegion(scene, sourceRegion) {
    return scene.data.tokens
        .filter(token => this._isTokenInRegion(scene, token, sourceRegion) && this._isProperToken(token));
  }

  _replicateTokenFromRegionToRegion(requestBatch, scene, token, sourceRegion, targetScene, targetRegion) {
    if (!this._isProperToken(token) || !this._isTokenInRegion(scene, token, sourceRegion)) {
      return;
    }
    requestBatch.createToken(targetScene,
        this._getReplicatedTokenCreateData(scene, token, sourceRegion, targetScene, targetRegion));
  }

  _updateReplicatedToken(requestBatch, sourceScene, sourceToken, sourceRegion, targetScene, targetToken, targetRegion) {
    if (!this._isProperToken(sourceToken) || !this._isReplicatedToken(targetToken) ||
        !this._isTokenInRegion(sourceScene, sourceToken, sourceRegion)) {
      return;
    }
    requestBatch.updateToken(targetScene,
        this._getReplicatedTokenUpdateData(sourceScene, sourceToken, sourceRegion, targetScene, targetToken, targetRegion));
  }

  _replicateTokenToAllRegions(requestBatch, scene, token) {
    if (!this._isProperToken(token)) {
      return;
    }

    this._getTaggedRegionsContainingToken(scene, token, MLT.TAG_SOURCE)
        .flatMap(r => this._getLinkedRegionsByTag(scene, r, MLT.TAG_SOURCE, MLT.TAG_TARGET))
        .forEach(([sourceRegion, targetScene, targetRegion]) =>
            this._replicateTokenFromRegionToRegion(requestBatch, scene, token, sourceRegion, targetScene, targetRegion));
  }

  _updateAllReplicatedTokens(requestBatch, scene, token) {
    if (!this._isProperToken(token)) {
      return;
    }

    const mappedRegions =  this._getTaggedRegionsContainingToken(scene, token, MLT.TAG_SOURCE)
        .flatMap(r => this._getLinkedRegionsByTag(scene, r, MLT.TAG_SOURCE, MLT.TAG_TARGET));

    const tokensToDelete = [];
    const tokensToUpdate = [];
    this._getReplicatedTokensForSourceToken(scene, token).forEach(([targetScene, targetToken]) => {
      const mappedRegion = mappedRegions.find(([sourceRegion, mapScene, mapRegion]) =>
          this._isReplicationForRegion(scene, sourceRegion, targetScene, targetToken) &&
          this._isReplicationForRegion(mapScene, mapRegion, targetScene, targetToken));

      if (mappedRegion) {
        tokensToUpdate.push([mappedRegion[0], targetScene, targetToken, mappedRegion[2]]);
      } else {
        tokensToDelete.push([targetScene, targetToken]);
      }
    });
    const tokensToCreate = mappedRegions.filter(([r0, s0, t0]) =>
        !tokensToUpdate.some(([r1, s1, _, t1]) => s0 === s1 && r0._id === r1._id && t0._id === t1._id));

    tokensToDelete.forEach(([scene, t]) => requestBatch.deleteToken(scene, t._id));
    tokensToUpdate.forEach(([sourceRegion, targetScene, t, targetRegion]) =>
        this._updateReplicatedToken(requestBatch, scene, token, sourceRegion, targetScene, t, targetRegion));
    tokensToCreate.forEach(([sourceRegion, targetScene, targetRegion]) =>
        this._replicateTokenFromRegionToRegion(requestBatch, scene, token, sourceRegion, targetScene, targetRegion));
  }

  _replicateAllFromSourceRegion(requestBatch, sourceScene, sourceRegion) {
    const tokens = this._getTokensToReplicateForRegion(sourceScene, sourceRegion);
    this._getLinkedRegionsByTag(sourceScene, sourceRegion, MLT.TAG_SOURCE, MLT.TAG_TARGET)
        .forEach(([_0, targetScene, targetRegion]) =>
            tokens.forEach(token =>
                this._replicateTokenFromRegionToRegion(requestBatch, sourceScene, token, sourceRegion, targetScene, targetRegion)));
  }

  _replicateAllToTargetRegion(requestBatch, targetScene, targetRegion) {
    this._getLinkedRegionsByTag(targetScene, targetRegion, MLT.TAG_TARGET, MLT.TAG_SOURCE)
      .forEach(([_, sourceScene, sourceRegion]) =>
          this._getTokensToReplicateForRegion(sourceScene, sourceRegion)
              .forEach(token =>
                  this._replicateTokenFromRegionToRegion(requestBatch, sourceScene, token, sourceRegion, targetScene, targetRegion)));
  }

  _removeReplicationsForSourceToken(requestBatch, scene, token) {
    this._getReplicatedTokensForSourceToken(scene, token)
        .forEach(([s, t]) => requestBatch.deleteToken(s, t._id));
  }

  _removeReplicationsForRegion(requestBatch, scene, region) {
    this._getReplicatedTokensForRegion(scene, region)
        .forEach(([s, t]) => requestBatch.deleteToken(s, t._id));
  }

  _execute(requestBatch) {
    // isUndo: true prevents these commands from being undoable themselves.
    const options = {isUndo: true};
    options[MLT.REPLICATED_UPDATE] = true;

    let promise = Promise.resolve(null);
    for (const [sceneId, data] of Object.entries(requestBatch._scenes)) {
      const scene = game.scenes.get(sceneId);
      if (scene && data.delete.length) {
        // Also remove from combats.
        for (const combat of game.combats.entities) {
          if (combat.scene === scene) {
            const combatants = data.delete.map(id => combat.getCombatantByToken(id)).flatMap(c => c ? [c._id] : []);
            if (combatants.length) {
              promise = promise.then(() => combat.deleteEmbeddedEntity("Combatant", combatants));
            }
          }
        }
        promise = promise.then(() => scene.deleteEmbeddedEntity(Token.embeddedName, data.delete, options));
      }
      if (scene && data.updateAnimated.length) {
        promise = promise.then(() => scene.updateEmbeddedEntity(Token.embeddedName, data.updateAnimated,
                                                                Object.assign({diff: true}, options)));
      }
      if (scene && data.updateInstant.length) {
        promise = promise.then(() => scene.updateEmbeddedEntity(Token.embeddedName, data.updateInstant,
                                                                Object.assign({diff: true, animate: false}, options)));
      }
      if (scene && data.updateDrawing.length) {
        promise = promise.then(() => scene.updateEmbeddedEntity(Drawing.embeddedName, data.updateDrawing,
                                                                Object.assign({diff: true}, options)));
      }
      if (scene && data.create.length) {
        promise = promise.then(() => scene.createEmbeddedEntity(Token.embeddedName, data.create, options));
      }
    }
    for (const f of requestBatch._extraActions) {
      promise = promise.then(f);
    }

    return promise;
  }

  // Executing multiple server requests concurrently seems to often result in requests being dropped or ignored.
  // To work around this, we use a batching system to minimize the number of requests we need to make, and queue
  // up requests if there's already some in progress.
  _queueAsync(f) {
    if (!this._isPrimaryGamemaster()) {
      return;
    }
    const batched = () => {
      const requestBatch = new MltRequestBatch();
      f(requestBatch);
      return this._execute(requestBatch);
    };
    const done = () => {
      if (--this._asyncCount === 0) {
        this._asyncQueue = null;
      }
    };
    if (this._asyncCount === 0) {
      const result = batched();
      ++this._asyncCount;
      this._asyncQueue = result.finally(done);
    } else {
      ++this._asyncCount;
      this._asyncQueue = this._asyncQueue.finally(batched).finally(done);
    }
  }

  refreshAll() {
    if (!this._isPrimaryGamemaster()) {
      return;
    }
    console.log(MLT.LOG_PREFIX, "Refreshing all");
    this._queueAsync(requestBatch => {
      game.scenes.forEach(scene => {
        scene.data.tokens
            .filter(this._isReplicatedToken.bind(this))
            .forEach(t => requestBatch.deleteToken(scene, t._id));
        scene.data.drawings
            .filter(r => this._isTaggedRegion(r, MLT.TAG_SOURCE))
            .forEach(r => this._replicateAllFromSourceRegion(requestBatch, scene, r));
      });
    });
  }

  _setLastTeleport(scene, token) {
    if (game.user.isGM) {
      this._lastTeleport[token._id] =
          this._getTaggedRegionsContainingToken(scene, token, [MLT.TAG_IN, MLT.TAG_INOUT]).map(r => r._id);
    }
  }

  // Teleport using standard teleport regions. Returns true if a teleport occurred, false otherwise.
  _doTeleport(scene, token) {
    if (!this._isPrimaryGamemaster()) {
      return false;
    }

    let inRegions = this._getTaggedRegionsContainingToken(scene, token, [MLT.TAG_IN, MLT.TAG_INOUT]);
    inRegions = this._filterRegionsAndUpdateLastTeleport(token, inRegions);
    if (!inRegions.length) {
      return false;
    }

    const inRegion = inRegions[Math.floor(inRegions.length * Math.random())];
    const inTag = this._isTaggedRegion(inRegion, MLT.TAG_IN) ? MLT.TAG_IN : MLT.TAG_INOUT;
    const outRegions = this._getLinkedRegionsByTag(scene, inRegion, inTag, [MLT.TAG_OUT, MLT.TAG_INOUT]);
    if (!outRegions.length) {
      return false;
    }

    const outRegion = outRegions[Math.floor(outRegions.length * Math.random())];
    const position = this._mapTokenPosition(scene, token, inRegion, outRegion[1], outRegion[2]);
    // TODO: wait for animation to complete before teleporting, if possible? This would avoid visual inconsistencies
    // where a token teleports before completing the move animation into the region.
    if (outRegion[1] === scene) {
      const animate = game.settings.get(MLT.SCOPE, MLT.SETTING_ANIMATE_TELEPORTS) || false;
      this._queueAsync(requestBatch => requestBatch.updateToken(scene, {
        _id: token._id,
        x: position.x,
        y: position.y,
      }, animate));
    } else {
      const data = duplicate(token);
      const id = data._id;
      delete data._id;
      data.x = position.x;
      data.y = position.y;

      const actor = game.actors.get(token.actorId);
      const owners = actor ? game.users.filter(u => !u.isGM && actor.hasPerm(u, "OWNER")) : [];

      this._queueAsync(requestBatch => {
        if (!scene.data.tokens.find(t => t._id === id)) {
          // If the token has already gone, don't teleport it. Otherwise we could end up with things like the token getting
          // duplicated multiple times.
          return;
        }
        requestBatch.deleteToken(scene, id);
        requestBatch.createToken(outRegion[1], data);
        owners.forEach(user => {
          requestBatch.extraAction(() => game.socket.emit("pullToScene", outRegion[1]._id, user._id));
        })
      });
    }

    return true;
  }

  // Teleport between levels within a scene using stair tokens.
  _doLevelTeleport(scene, token) {
    if (!this._isPrimaryGamemaster() || token.name === MLT.TOKEN_STAIRS) {
      return false;
    }

    const levelRegions = this._getTaggedRegionsContainingToken(scene, token, [MLT.TAG_LEVEL]);
    if (!levelRegions.length) {
      return false;
    }

    const allStairTokens = scene.data.tokens.filter(t => t.name === MLT.TOKEN_STAIRS);
    const sourceStairTokens =
        allStairTokens.filter(t => this._isPointInToken(scene, this._getTokenCentre(scene, token), t));
    if (!sourceStairTokens.length) {
      return false;
    }

    const targetStairTokens = [];

    // Iterate over all level regions the token is in. These may overlap, so loop and try each.
    for (const levelRegion of levelRegions) {
      // Get all the level regions that are one below or one above our level (e.g. @level:1 -> @level:0 and @level:2).
      const adjacentLevelRegions = this._getNumericallyAdjacentLevelRegions(scene, levelRegion);
      if (!adjacentLevelRegions.length) {
        continue;
      }

      // Find all matching staircases in the adjacent levels.
      for (const adjacentRegion of adjacentLevelRegions) {
        for (const sourceStairToken of sourceStairTokens) {
          // Check if our token, when moved to the other level's region, would overlap a stair token.
          const targetPosition = this._mapTokenPosition(scene, sourceStairToken, levelRegion, scene, adjacentRegion);
          const linkedStairToken = allStairTokens.find(t => this._isPointInToken(scene, targetPosition, t));
          if (linkedStairToken) {
            targetStairTokens.push(linkedStairToken);
          }
        }
      }
    }

    if (!targetStairTokens.length) {
      return false;
    }
    const targetStairToken = targetStairTokens[Math.floor(targetStairTokens.length * Math.random())];
    const animate = game.settings.get(MLT.SCOPE, MLT.SETTING_ANIMATE_TELEPORTS) || false;
    this._queueAsync(requestBatch => requestBatch.updateToken(scene, {
      _id: token._id,
      x: targetStairToken.x,
      y: targetStairToken.y,
    }, animate));
    return true;
  }

  _allowTokenOperation(token, options) {
    return !this._isReplicatedToken(token) || (MLT.REPLICATED_UPDATE in options);
  }

  _onReady() {
    // Replications might be out of sync if there was previously no GM and we just logged in.
    if (this._isOnlyGamemaster()) {
      this.refreshAll();
    }
  }

  _onUpdateScene(scene) {
    if (this._isPrimaryGamemaster()) {
      // Workaround for issue where imported scene contains drawings whose author is an invalid user ID.
      // Can assume a GM took the import action and update to use their ID instead.
      this._queueAsync(requestBatch => {
        scene.data.drawings.filter(d => !game.users.find(u => u.id === d.author)).forEach(d => {
          requestBatch.updateDrawing(scene, {
            _id: d._id,
            author: game.user.id,
          });
        });
      });
    }
    this.refreshAll();
    return true;
  }

  _onCreateDrawing(scene, drawing, options, userId) {
    if (this._isTaggedRegion(drawing, MLT.TAG_SOURCE)) {
      const d = duplicate(drawing);
      this._queueAsync(requestBatch => this._replicateAllFromSourceRegion(requestBatch, scene, d));
    } else if (this._isTaggedRegion(drawing, MLT.TAG_TARGET)) {
      const d = duplicate(drawing);
      this._queueAsync(requestBatch => this._replicateAllToTargetRegion(requestBatch, scene, d));
    }
  }

  _onPreUpdateDrawing(scene, drawing, update, options, userId) {
    this._onDeleteDrawing(scene, drawing, update, options, userId);
    return true;
  }

  _onUpdateDrawing(scene, drawing, update, options, userId) {
    this._onCreateDrawing(scene, drawing, options, userId);
  }

  _onDeleteDrawing(scene, drawing, options, userId) {
    if (this._isTaggedRegion(drawing, [MLT.TAG_SOURCE, MLT.TAG_TARGET])) {
      const d = duplicate(drawing);
      this._queueAsync(requestBatch => this._removeReplicationsForRegion(requestBatch, scene, d));
    }
  }

  _onPreCreateToken(scene, token, options, userId) {
    return this._allowTokenOperation(token, options);
  }

  _onCreateToken(scene, token, options, userId) {
    if (this._isProperToken(token)) {
      const t = duplicate(token);
      this._queueAsync(requestBatch => this._replicateTokenToAllRegions(requestBatch, scene, t));
      this._setLastTeleport(scene, token);
    }
  }

  _onPreUpdateToken(scene, token, update, options, userId) {
    if (this._allowTokenOperation(token, options) || this._isInvalidReplicatedToken(scene, token)) {
      return true;
    }
    // Attempt to update replicated token.
    if ('x' in update || 'y' in update || 'rotation' in update) {
      return false;
    }
    const sourceScene = this._getSourceSceneForReplicatedToken(scene, token);
    const sourceToken = this._getSourceTokenForReplicatedToken(scene, token);
    if (sourceScene && sourceToken) {
      const newUpdate = duplicate(update);
      newUpdate._id = sourceToken._id;
      sourceScene.updateEmbeddedEntity(Token.embeddedName, newUpdate, options);
    }
    return false;
  }

  _onUpdateToken(scene, token, update, options, userId) {
    if (MLT.REPLICATED_UPDATE in options && "animate" in options && !options.animate &&
        ('x' in update || 'y' in update)) {
      // Workaround for issues with a non-animated position update on a token that is already animating.
      const canvasToken = canvas.tokens.placeables.find(t => t.id === token._id);
      if (canvasToken && canvasToken._movement) {
        canvasToken._movement = null;
        canvasToken.stopAnimation();
        canvasToken._onUpdate({x: token.x, y: token.y}, {animate: false});
        canvas.triggerPendingOperations();
      }
    }
    if (this._isProperToken(token)) {
      const t = duplicate(token);
      this._queueAsync(requestBatch => this._updateAllReplicatedTokens(requestBatch, scene, t));
      if (MLT.REPLICATED_UPDATE in options) {
        this._setLastTeleport(scene, token);
      } else {
        this._doTeleport(scene, token) || this._doLevelTeleport(scene, token);
      }
    }
  }

  _onPreDeleteToken(scene, token, options, userId) {
    return this._allowTokenOperation(token, options) || this._isInvalidReplicatedToken(scene, token);
  }

  _onDeleteToken(scene, token, options, userId) {
    if (this._isProperToken(token)) {
      const t = duplicate(token);
      this._queueAsync(requestBatch => this._removeReplicationsForSourceToken(requestBatch, scene, t));
      delete this._lastTeleport[token._id];
    }
  }

  _onTargetToken(user, token, targeted) {
    // Auto-targetting handled on user's client, since targetting is scene-local.
    if (user !== game.user || !game.settings.get(MLT.SCOPE, MLT.SETTING_AUTO_TARGET)) {
      return;
    }
    this._getAllLinkedCanvasTokens(token.data).forEach(t => {
      if (t !== token && targeted !== user.targets.has(t)) {
        t.setTarget(targeted, {releaseOthers: false, groupSelection: true});
      }
    });
  }

  _onPreCreateCombatant(combat, combatant, options, userId) {
    const token = combat.scene.data.tokens.find(t => t._id === combatant.tokenId);
    if (!token || !this._isReplicatedToken(token)) {
      return true;
    }
    const sourceScene = this._getSourceSceneForReplicatedToken(combat.scene, token);
    if (sourceScene !== combat.scene) {
      return true;
    }
    const sourceToken = this._getSourceTokenForReplicatedToken(combat.scene, token);
    if (sourceToken) {
      const activeCombatant = combat.getCombatantByToken(sourceToken._id);
      if (activeCombatant) {
        combat.deleteEmbeddedEntity("Combatant", activeCombatant._id);
      } else {
        combat.createEmbeddedEntity("Combatant", { tokenId: sourceToken._id, hidden: sourceToken.hidden});
      }
    }
    return false;
  }

  _onCreateChatMessage(message, options, userId) {
    if (!options.chatBubble || !canvas.ready || !game.settings.get(MLT.SCOPE, MLT.SETTING_AUTO_CHAT_BUBBLE)) {
      return;
    }
    const scene = game.scenes.get(message.data.speaker.scene);
    if (!scene) {
      return;
    }
    const token = scene.data.tokens.find(t => t._id === message.data.speaker.token);
    if (!token) {
      return;
    }
    this._getAllLinkedCanvasTokens(token).forEach(t => {
      if (t.scene !== scene || t.data._id !== token._id) {
        canvas.hud.bubbles.say(t, message.data.content, {emote: message.data.type === CONST.CHAT_MESSAGE_TYPES_EMOTE});
      }
    })
  }
}

console.log(MLT.LOG_PREFIX, "Loaded");
Hooks.on('init', () => game.multilevel = new MultilevelTokens());
