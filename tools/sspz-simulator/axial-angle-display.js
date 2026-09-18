// Display coordinates only. Never selects candidates or changes their weights.
globalThis.SSPZAngles = Object.freeze({
  offset(c, base, view) {
    const V = c.viewSamples;
    return ((view - base) % V + V) % V * 360 / V;
  },
  view(point, coordinate) {
    return coordinate === 'own' ? point.view : point.referenceView;
  },
  pair(c, base, referenceView) {
    return [0, 1].map(direction => {
      const view = referenceView + direction * c.viewSamples / 2;
      const theta = c.phase + view * 2 * Math.PI / c.viewSamples;
      const gamma = c.axialRule === 'parallel' ? 0 : Math.asin(-c.radius * Math.sin(theta) / c.sourceRadius);
      const beta = theta + gamma;
      return { direction, view, theta, gamma, beta,
        referenceOffset: this.offset(c, base, referenceView),
        ownOffset: this.offset(c, base, view) };
    });
  }
});
