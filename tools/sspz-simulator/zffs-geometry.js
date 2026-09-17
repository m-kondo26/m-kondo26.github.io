// Two alternating axial focal positions with a fixed cylindrical detector.
// The quarter-row default follows the isocentre interlacing in Mori (2008),
// Fig. 4 / Eqs. 19-22. Pure axial motion is an explicit idealization.
export const ZFFS_VERSION='2026-09-17.1';
export function zffsConfig(input,c){
  c.zFfsEnabled=input.zFfsEnabled===true||input.zFfsEnabled===1||input.zFfsEnabled==='1';
  if(!c.zFfsEnabled)return c;
  c.zFfsMagnification=Number(input.zFfsMagnification??(1072/600));
  c.zFfsOffset=Number(input.zFfsOffset??.25);
  if(!(Number.isFinite(c.zFfsMagnification)&&c.zFfsMagnification>1&&c.zFfsMagnification<=4))throw Error('ZFFS_GEOMETRY: detector magnification must be > 1 and <= 4');
  if(!(Number.isFinite(c.zFfsOffset)&&c.zFfsOffset>=0&&c.zFfsOffset<=.5))throw Error('ZFFS_GEOMETRY: isocentre half-offset must be 0 to 0.5 row pitches');
  if(c.axialRule==='parallel')throw Error('ZFFS_GEOMETRY: focal switching requires cone-ray geometry');
  c.zFfsSourceDetectorMm=c.sourceRadius*c.zFfsMagnification;
  if(c.zFfsSourceDetectorMm<=c.sourceRadius+c.radius)throw Error('ZFFS_GEOMETRY: detector must lie beyond the evaluation point for every view');
  c.zFfsSourceOffsetMm=c.zFfsOffset*c.rowWidth/(1-1/c.zFfsMagnification);
  return c;
}
export function zffsState(view){return ((view%2)+2)%2;}
export function zffsShift(c,focus){return (focus===0?-1:1)*c.zFfsSourceOffsetMm;}
export function zffsRowGeometry(c,view,row){
  const beta=c.phase+2*Math.PI*view/c.viewSamples;
  const L=Math.hypot(c.sourceRadius*Math.cos(beta)-c.radius,c.sourceRadius*Math.sin(beta));
  const focus=zffsState(view),shift=zffsShift(c,focus),baseZ=c.feed*view/c.viewSamples;
  const spacing=c.rowWidth*L/c.sourceRadius;
  const origin=baseZ+shift*(1-L/c.zFfsSourceDetectorMm);
  return {view,row,focus,beta,theta:beta,sourceZ:baseZ+shift,baseZ,L,spacing,z:origin+(row-(c.rows-1)/2)*spacing};
}
export function zffsRebinStencil(c,theta,focus){
  const gamma=Math.asin(-c.radius*Math.sin(theta)/c.sourceRadius),beta=theta+gamma;
  // Coincident foci are one acquisition trajectory: use the original full grid.
  const stride=c.zFfsOffset===0?1:2,origin=c.zFfsOffset===0?0:focus;
  const vf=(beta-c.phase)*c.viewSamples/(2*Math.PI),q=(vf-origin)/stride,i=Math.floor(q),a=q-i;
  const jf=gamma*c.sourceRadius/c.channelWidth+(c.channels-1)/2,j=Math.floor(jf),b=jf-j;
  const out=[];
  for(const [view,wv] of [[origin+stride*i,1-a],[origin+stride*(i+1),a]])for(const [channel,wc] of [[j,1-b],[j+1,b]]){
    const weight=wv*wc;if(weight>1e-14)out.push({view,channel,weight});
  }
  return {beta,gamma,stencil:out};
}
