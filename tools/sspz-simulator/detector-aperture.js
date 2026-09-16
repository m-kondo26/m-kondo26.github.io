// Shared physical cell aperture. Coordinates, pitch and aperture use the same
// units. Sampling pitch is not aperture width; a gap is not filled by a ray.
export function detectorCellMembership(coordinate, pitch, aperture, count) {
  if (!(pitch > 0 && aperture > 0 && aperture <= pitch && Number.isInteger(count) && count > 0))
    throw Error('DETECTOR_APERTURE: require 0 < aperture <= channel spacing');
  const q=coordinate/pitch+(count-1)/2, radius=aperture/(2*pitch), out=[];
  for(let k=Math.max(0,Math.ceil(q-radius-1e-10));k<=Math.min(count-1,Math.floor(q+radius+1e-10));k++){
    const distance=Math.abs(q-k), boundary=Math.abs(distance-radius)<=1e-10;
    if(boundary||distance<radius)out.push([k,boundary?.5:1]);
  }
  return out;
}

// A unit-integral Cartesian point projected onto the source-centred cylinder.
// Transaxial coordinates are R*gamma; axial coordinates are cylinder heights.
// parallel=true is the explicitly nondivergent reference acquisition, not FBP.
export function detectorPointProjection(c,beta,zObject,parallel=false){
  const R=c.sourceRadius, L=parallel?R:Math.hypot(R*Math.cos(beta)-c.radius,R*Math.sin(beta));
  const transverse=parallel?-c.radius*Math.sin(beta):R*Math.atan2(-c.radius*Math.sin(beta),R-c.radius*Math.cos(beta));
  const sourceZ=c.sourceZ, w=parallel?zObject-sourceZ:R*(zObject-sourceZ)/L;
  const aperture=c.channelApertureMm??c.channelWidth;
  const js=detectorCellMembership(transverse,c.channelWidth,aperture,c.channels);
  const ks=detectorCellMembership(w,c.rowWidth,c.rowWidth,c.rows);
  const empty={j0:0,j1:-1,k0:0,k1:-1,width:0,height:0,data:new Float64Array(0),transverse,w};
  if(!js.length||!ks.length)return empty;
  const j0=js[0][0],j1=js.at(-1)[0],k0=ks[0][0],k1=ks.at(-1)[0];
  const width=j1-j0+1,height=k1-k0+1,data=new Float64Array(width*height);
  const signal=parallel?1/(aperture*c.rowWidth):Math.hypot(R,w)/(L*L*(aperture/R)*c.rowWidth);
  for(const [j,a] of js)for(const [k,b] of ks)data[(k-k0)*width+j-j0]=signal*a*b;
  return {j0,j1,k0,k1,width,height,data,transverse,w};
}

// Read the acquired, cell-averaged data at the ray through the transverse point.
// This is interpolation of acquired channels, not an average of finished SSPs.
export function detectorRowReadout(c,p,row){
  if(row<p.k0||row>p.k1)return 0;
  const q=p.transverse/c.channelWidth+(c.channels-1)/2,j=Math.floor(q),a=q-j;
  const at=k=>k<p.j0||k>p.j1?0:p.data[(row-p.k0)*p.width+k-p.j0];
  return (1-a)*at(j)+a*at(j+1);
}
