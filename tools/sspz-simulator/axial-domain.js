// The ideal, noise-free point response has a known zero baseline. Check its
// support BEFORE min-max normalization; subtracting a clipped tail hides it.
export const AXIAL_TAIL_TOLERANCE=1e-10;
export const AXIAL_MAX_EXTENT_MM=80;
export function axialRawTailFraction(raw,max){
  return max>0?Math.max(Math.abs(raw[0]),Math.abs(raw[raw.length-1]))/max:0;
}
export function assertAxialRawDomain(raw,max){
  if(!Number.isFinite(max)||!raw.every(Number.isFinite))throw Error('AXIAL_NUMERIC: non-finite raw response');
  const fraction=axialRawTailFraction(raw,max);
  if(fraction>AXIAL_TAIL_TOLERANCE){
    const error=Error('AXIAL_DOMAIN_TAILS: raw response extends beyond the axial calculation range');
    error.code='AXIAL_DOMAIN_TAILS';error.rawTailFraction=fraction;
    throw error;
  }
}
export function expandAxialDomain(c){
  // Grow by whole grid intervals so widening never coarsens the requested
  // sampling or moves the existing grid relative to the point object.
  const half=(c.zSamples-1)/2;
  const next=Math.min(2*half,Math.floor(AXIAL_MAX_EXTENT_MM/c.zStep));
  if(next<=half)throw Error('AXIAL_DOMAIN_LIMIT: response tails exceed the maximum calculation range of +/-80 mm; widths were not reported');
  return {...c,zSamples:2*next+1,zExtent:next*c.zStep};
}
