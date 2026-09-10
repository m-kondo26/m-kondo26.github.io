// Presentation/export only: does not alter the acquisition or response model.
globalThis.SSPZShape = (() => {
  function analyze(overlay, key, step = 0.01) {
    const {z, zCount:n, stateCount:count} = overlay, c=overlay[key], valid=[], mid=[];
    for(let s=0;s<count;s++) {
      if(c.coverage[s]<1-1e-7) continue;
      const y=c.final.subarray(s*n,(s+1)*n);let peak=0;
      for(let i=1;i<n;i++) if(y[i]>y[peak]) peak=i;
      const level=y[peak]/2;let l=peak,r=peak;
      while(l>0&&y[l]>=level)l--;while(r<n-1&&y[r]>=level)r++;
      if(l===peak||r===peak||y[l]>=level||y[r]>=level)continue;
      const left=z[l]+(level-y[l])*(z[l+1]-z[l])/(y[l+1]-y[l]);
      const right=z[r-1]+(level-y[r-1])*(z[r]-z[r-1])/(y[r]-y[r-1]);
      valid.push(s);mid.push((left+right)/2);
    }
    if(!valid.length)throw new Error('No complete profiles with valid bilateral FWHM crossings.');
    const start=Math.ceil(Math.max(...mid.map(m=>z[0]-m))/step-1e-9);
    const stop=Math.floor(Math.min(...mid.map(m=>z[n-1]-m))/step+1e-9);
    const x=Float64Array.from({length:Math.max(0,stop-start+1)},(_,i)=>(start+i)*step);
    if(!x.length)throw new Error('No shared aligned support.');
    const aligned=valid.map((s,j)=>{
      const out=new Float64Array(x.length);let k=0;
      for(let i=0;i<x.length;i++) {
        const target=x[i]+mid[j];while(k<n-2&&z[k+1]<target)k++;
        const t=(target-z[k])/(z[k+1]-z[k]);
        out[i]=c.final[s*n+k]*(1-t)+c.final[s*n+k+1]*t;
      }return out;
    });
    const mean=Float64Array.from(x,(_,i)=>aligned.reduce((sum,y)=>sum+y[i],0)/valid.length);
    const delta=aligned.map(y=>Float64Array.from(y,(v,i)=>v-mean[i]));
    const bins=60,low=-.06,width=.002, hist=new Float64Array(x.length*bins),outside=new Uint16Array(x.length);
    delta.forEach(y=>y.forEach((v,i)=>{let b=Math.floor((v-low)/width);if(b===bins&&v<=.06+1e-12)b=bins-1;if(b<0||b>=bins)outside[i]++;else hist[i*bins+b]+=1/valid.length;}));
    return {x,valid,mid,aligned,mean,delta,hist,outside,bins,low,width,step};
  }
  const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  function column(i){let s='';for(i++;i;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;}
  function sheet(rows) {
    return '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" state="frozen"/></sheetView></sheetViews><sheetData>'+rows.map((row,r)=>'<row r="'+(r+1)+'">'+row.map((v,c)=>{const ref=column(c)+(r+1);return typeof v==='number'&&Number.isFinite(v)?'<c r="'+ref+'"><v>'+v+'</v></c>':'<c r="'+ref+'" t="inlineStr"><is><t>'+escape(v??'')+'</t></is></c>';}).join('')+'</row>').join('')+'</sheetData></worksheet>';
  }
  async function zip(files) {
    const enc=new TextEncoder(),parts=[],directory=[];let offset=0;
    const table=Uint32Array.from({length:256},(_,i)=>{let v=i;for(let b=0;b<8;b++)v=v&1?0xedb88320^(v>>>1):v>>>1;return v>>>0;});
    for(const [name,content] of files){const nameBytes=enc.encode(name),bytes=enc.encode(content);let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);crc=(crc^0xffffffff)>>>0;
      let packed=bytes,method=0;
      try {packed=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());method=8;} catch { /* Standards-compatible uncompressed ZIP fallback. */ }
      const head=new Uint8Array(30+nameBytes.length),h=new DataView(head.buffer);h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(8,method,true);h.setUint32(14,crc,true);h.setUint32(18,packed.length,true);h.setUint32(22,bytes.length,true);h.setUint16(26,nameBytes.length,true);head.set(nameBytes,30);
      const entry=new Uint8Array(46+nameBytes.length),e=new DataView(entry.buffer);e.setUint32(0,0x02014b50,true);e.setUint16(4,20,true);e.setUint16(6,20,true);e.setUint16(10,method,true);e.setUint32(16,crc,true);e.setUint32(20,packed.length,true);e.setUint32(24,bytes.length,true);e.setUint16(28,nameBytes.length,true);e.setUint32(42,offset,true);entry.set(nameBytes,46);directory.push(entry);parts.push(head,packed);offset+=head.length+packed.length;
    }
    const size=directory.reduce((n,a)=>n+a.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,files.length,true);e.setUint16(10,files.length,true);e.setUint32(12,size,true);e.setUint32(16,offset,true);
    return new Blob([...parts,...directory,end],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }
  function workbook(result,analyses,version){
    const o=result.overlay,sheets=[];
    sheets.push(['Readme',[
      ['SSPz simulation export','Value'],['model_version',version],['export_version','2026-09-11.1'],['generated_utc',new Date().toISOString()],
      ['normalization','Peak-normalized model profiles; no measured data'],['native_coordinate','reconstruction-plane minus fixed-object position (mm)'],['aligned_coordinate','z position relative to native FWHM midpoint (mm)'],['alignment','Bilateral native linear half-height crossings; translation only'],['resampling','0.01 mm linear grid; common finite support; no extrapolation or smoothing'],['deviation','Each aligned profile minus its condition-specific pointwise arithmetic mean'],['inclusion','Complete coverage and valid bilateral FWHM crossings; excluded states retained in Native sheets'],['numeric_storage','Native model overlay arrays are Float32; exported without display rounding'],['distribution','Fractions describe sampled model states, not measured tube-angle probabilities'],['histogram','Bins -0.06 to +0.06, width 0.002; intensity sqrt(fraction), fixed 0..1'],['units','Positions and widths: mm; normalized SSPz and deviations: dimensionless'],['off_condition','Parallel reference; no cone distance scaling'],['on_condition','Fan-beam cone geometry'],...Object.entries(result.params).map(([k,v])=>['parameter_'+k,typeof v==='object'?JSON.stringify(v):v])]]);
    for(const key of ['off','on']){const a=analyses[key],ids=Array.from({length:o.stateCount},(_,i)=>'state_'+i);
      const nativeRows=Array.from(o.z,(z,i)=>[z,...ids.map((_,s)=>o[key].final[s*o.zCount+i])]);
      sheets.push([key+'_Native',[['z_position_mm',...ids],...nativeRows]]);
      const headers=['z_position_mm',...a.valid.map(s=>'state_'+s)];
      for(const [label,series] of [['Aligned',a.aligned],['Deviation',a.delta]])sheets.push([key+'_'+label,[headers,...Array.from(a.x,(z,i)=>[z,...series.map(y=>y[i])])]]);
      sheets.push([key+'_Mean',[['z_position_mm','mean_sspz','outside_histogram_count'],...Array.from(a.x,(z,i)=>[z,a.mean[i],a.outside[i]])]]);
      sheets.push([key+'_States',[['state_index','object_position_fraction','included_in_shape','FWHM_midpoint_mm','coverage'],...ids.map((_,s)=>{const j=a.valid.indexOf(s);return [s,o.states[s],j>=0?1:0,j>=0?a.mid[j]:'',o[key].coverage[s]];})]]);
    }
    const keys=Object.keys(result.sweep[0]??{});sheets.push(['Width_metrics',[keys,...result.sweep.map(r=>keys.map(k=>r[k]))]]);
    const files=[['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+sheets.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+'</Types>'],['_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],['xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+sheets.map(([name],i)=>'<sheet name="'+escape(name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>'],['xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+'</Relationships>']];
    sheets.forEach(([,rows],i)=>files.push(['xl/worksheets/sheet'+(i+1)+'.xml',sheet(rows)]));return zip(files);
  }
  return {analyze,workbook};
})();
