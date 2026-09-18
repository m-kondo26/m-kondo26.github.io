// Display coordinates only. Never selects candidates or changes their weights.
globalThis.SSPZAngles = Object.freeze({
  offset(c, base, view) {
    const V = c.viewSamples;
    return ((view - base) % V + V) % V * 360 / V;
  },
  view(point, coordinate) {
    return coordinate === 'own' ? point.view : point.referenceView;
  },
  // Each existing pair supplies two output directions. Acquired/rebinned
  // identities stay fixed; only their roles relative to the output change.
  // Over T, the same directional datum can occur with different opposing
  // views. Sum those contributions for a single correctly shaded marker.
  expand(points, c) {
    const map = new Map(), half = c.viewSamples / 2;
    for (const p of points) for (const reverse of [false, true]) {
      const referenceView = p.referenceView + (reverse ? half : 0);
      const oppositeView = p.referenceView + (reverse ? 0 : half);
      const direction = reverse ? 1 - p.direction : p.direction;
      const key = `${referenceView}:${direction}:${p.view}:${p.focus ?? 0}:${p.row}`;
      let q = map.get(key);
      if (!q) {
        q = {...p, referenceView, direction, weight: 0, oppositeViews: [], sourcePairReferenceViews: []};
        if (p.referenceWeight !== undefined) q.referenceWeight = 0;
        map.set(key, q);
      }
      q.weight += p.weight;
      if (p.referenceWeight !== undefined) q.referenceWeight += p.referenceWeight;
      if (!q.oppositeViews.includes(oppositeView)) q.oppositeViews.push(oppositeView);
      if (!q.sourcePairReferenceViews.includes(p.referenceView)) q.sourcePairReferenceViews.push(p.referenceView);
    }
    return [...map.values()].map(p => ({...p,
      oppositeView: p.oppositeViews.length === 1 ? p.oppositeViews[0] : null}));
  },
  animation(audit) {
    if (audit.directionalFullTurn) return audit;
    const total = this.expand(audit.total, audit.config), roles = new Map();
    const key = p => `${p.view}:${p.focus ?? 0}:${p.row}`;
    for (const p of total) {
      if (!roles.has(key(p))) roles.set(key(p), [0, 0]);
      roles.get(key(p))[p.direction] += p.weight;
    }
    const classify = points => points.map(p => {
      const [directWeight, complementaryWeight] = roles.get(key(p)) ?? [0, 0];
      return {...p, directWeight, complementaryWeight};
    });
    return {...audit, directionalFullTurn: true, angularMeanFactor: 1 / audit.config.viewSamples,
      total: classify(total), frames: audit.frames.map(frame => ({...frame,
        instant: classify(this.expand(frame.instant, audit.config)),
        accumulated: classify(this.expand(frame.accumulated, audit.config))})),
      coordinate: 'Full-turn output interpolation direction; opposing rebinned data at theta +/- pi',
      definition: audit.definition + ' Both output directions shown; angular mean factor 1/V. No change to acquisition support or SSP.'};
  },
  weightAudit(result) {
    if (!result.weightAudit?.pairedSamples) return null;
    return {definition: 'Full-turn directional representation of the same coefficients. Alternative to weightAudit, not additive.',
      angularMeanFactor: 1 / result.config.viewSamples,
      samples: this.expand(result.weightAudit.pairedSamples, result.config)};
  },
  sample(c, base, point) {
    const theta=c.phase+point.view*2*Math.PI/c.viewSamples;
    const gamma=c.axialRule==='parallel'?0:Math.asin(-c.radius*Math.sin(theta)/c.sourceRadius);
    return {...point,theta,gamma,beta:theta+gamma,referenceOffset:this.offset(c,base,point.referenceView),ownOffset:this.offset(c,base,point.view)};
  },
  pair(c, base, referenceView, oppositeView = referenceView + c.viewSamples / 2) {
    return [0, 1].map(direction => {
      const view = direction ? oppositeView : referenceView;
      const theta = c.phase + view * 2 * Math.PI / c.viewSamples;
      const gamma = c.axialRule === 'parallel' ? 0 : Math.asin(-c.radius * Math.sin(theta) / c.sourceRadius);
      const beta = theta + gamma;
      return { direction, view, theta, gamma, beta,
        referenceOffset: this.offset(c, base, referenceView),
        ownOffset: this.offset(c, base, view) };
    });
  }
});
