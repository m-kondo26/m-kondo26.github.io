// Drawing order only: each row trajectory retains its original coordinates.
// Both roles of the same datum use the same unwrapped source angle beta.
globalThis.SSPZConstruction=Object.freeze({
  window(scene,xLimit){
    let lo=Infinity,hi=-Infinity;
    for(const t of scene.traceFamilies)for(const turn of scene.traceGeometry.turns){
      for(const offset of scene.traceGeometry.rowOffsets){
        for(let i=1;i<t.angles.length;i++){
          const a=t.axial[i-1]+turn*scene.traceGeometry.feed+t.scales[i-1]*offset-scene.z0;
          const b=t.axial[i]+turn*scene.traceGeometry.feed+t.scales[i]*offset-scene.z0;
          let u=0,v=1;
          if(a===b){if(Math.abs(a)>xLimit)continue;}
          else {const q=(-xLimit-a)/(b-a),r=(xLimit-a)/(b-a);u=Math.max(0,Math.min(q,r));v=Math.min(1,Math.max(q,r));if(u>v)continue;}
          const beta=t.sourceAngles[i-1]+turn*2*Math.PI,db=t.sourceAngles[i]-t.sourceAngles[i-1];
          lo=Math.min(lo,beta+u*db);hi=Math.max(hi,beta+v*db);
        }
      }
    }
    // Zero refers to the direct/output direction of the diagram, not a new source
    // phase. Its beta includes the fan-angle offset and repeats each turn.
    const phase=scene.traceFamilies.find(t=>t.family==='direct')?.sourceAngles[0]??scene.sourcePhase??0,tau=2*Math.PI;
    if(!Number.isFinite(lo))return {start:phase,end:phase+tau,turns:1};
    // Begin at diagram angle zero, outside the left plot edge.
    const start=phase+Math.floor((lo-phase)/tau-1e-10)*tau;
    const end=phase+Math.ceil((hi-phase)/tau+1e-10)*tau;
    return {start,end,turns:(end-start)/tau};
  },
  prefix(trace,turn,cutoff){
    const t=cutoff-turn*2*Math.PI,beta=trace.sourceAngles,n=beta.length;
    if(t>=beta[n-1])return trace;
    if(t<beta[0])return {...trace,angles:[],axial:[],scales:[],sourceAngles:[]};
    let lo=0,hi=n-1;
    while(lo+1<hi){const m=(lo+hi)>>1;if(beta[m]<=t)lo=m;else hi=m;}
    const f=(t-beta[lo])/(beta[hi]-beta[lo]),out={...trace,frontier:true};
    for(const k of ['angles','axial','scales','sourceAngles']){
      out[k]=Array.from(trace[k].slice(0,lo+1));
      if(f>0)out[k].push(trace[k][lo]+f*(trace[k][hi]-trace[k][lo]));
    }
    return out;
  },
  role(scene,role,cutoff=null){
    return {...scene,visibleRole:role,
      traceFamilies:scene.traceFamilies.filter(t=>role==='all'||t.family===role),
      construction:cutoff===null?null:{cutoff}};
  }
});
