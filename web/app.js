/* Istanbul methane: Google Photorealistic 3D Tiles + depth-aware volumetric plumes.
   Deterministic frame API for headless capture: window.__ready, window.__frame(i). */
'use strict';
const Q = new URLSearchParams(location.search);
const LIVE = Q.get('mode') !== 'render';            // interactive app unless the renderer drives the page
let storedKey = ''; try { storedKey = localStorage.getItem('gmaps_key') || ''; } catch (e) {}
const KEY = Q.get('key') || (LIVE ? (window.PUBLIC_MAPS_KEY || storedKey) : '');
// base layer: Google Photorealistic 3D Tiles when a key is available, else the open map (Esri imagery on open terrain, no key)
const FORCE_OPEN = Q.get('base') === 'open' || !!Q.get('nokey');
const FPS = +(Q.get('fps') || 30);
const SSE = +(Q.get('sse') || (LIVE ? 10 : 6));
const STEPS = +(Q.get('steps') || 56);
const VOLSCALE = +(Q.get('volscale') || 0.5);
const LOOK = Q.get('look') || 'ember';
const VEX = +(Q.get('vex') || 1.6);                 // vertical exaggeration of the modelled plume height
const DEBUG = +(Q.get('debug') || 0);
let loadP = 0;                                      // loading-screen progress, 0..1 (only ever increases)
const $ = id => document.getElementById(id);
(function webglCheck() {
  let ok = false; try { ok = !!document.createElement('canvas').getContext('webgl2'); } catch (e) {}
  if (!ok) { const el = $('bootError'); if (el) { el.style.display = 'flex'; el.querySelector('p').textContent = 'This 3D view needs WebGL 2, which this browser or device has turned off. Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration enabled.'; } throw new Error('WebGL 2 unavailable'); }
})();
if (LIVE && Q.get('key')) { try { localStorage.setItem('gmaps_key', Q.get('key')); } catch (e) {} const u = new URL(location.href); u.searchParams.delete('key'); history.replaceState(null, '', u); }
if (+(new URLSearchParams(location.search).get('debug') || 0) >= 2) document.documentElement.classList.add('nohud');
if (!LIVE) document.documentElement.classList.add('render');

/* ---------------- data ---------------- */
const SITES = {
  silivri: { b: [28.081055, 41.175682, 28.214951, 41.276323], name: 'Silivri', side: 'European side', full: 'Silivri landfill', img: 'data/basemap-silivri.webp' },
  sile:    { b: [29.313498, 41.098435, 29.418554, 41.177556], name: 'Şile',    side: 'Asian side',    full: 'Kömürcüoda landfill', img: 'data/basemap-sile.webp' },
};
function decode([w, h, s]) { const g = new Int8Array(w * h).fill(-1); let i = 0, k = 0; while (k < s.length) { const c = s[k]; if (c === '.') { i++; k++; } else if (c === '~') { const j = s.indexOf(';', k); i += +s.slice(k + 1, j); k = j + 1; } else { g[i++] = parseInt(c, 16); k++; } } return { w, h, g }; }
const GRAY = IMGS.map(im => { const { w, h, g } = decode(im); let mx = 1; for (const v of g) if (v > mx) mx = v; const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); const d = x.createImageData(w, h);
  for (let i = 0; i < g.length; i++) { const v = g[i]; if (v < 0) continue; const t = 0.08 + 0.92 * (v / mx); const b = Math.round(255 * Math.pow(t, 0.9)); d.data[i * 4] = b; d.data[i * 4 + 1] = b; d.data[i * 4 + 2] = b; d.data[i * 4 + 3] = 255; }
  x.putImageData(d, 0, 0); return c; });
const plumes = PLUMES.map(p => ({ id: p[0], site: p[1], t: p[2], plat: p[3], lon: p[4], lat: p[5], q: p[6], u: p[7], ws: p[8], wd: p[9], b: p[10], img: p[11] }));
const sc = {}; for (const p of plumes) { const k = p.site + '|' + p.t; (sc[k] = sc[k] || { site: p.site, t: p.t, plat: p.plat, ws: p.ws, wd: p.wd, plumes: [] }).plumes.push(p); }
const SCENES = Object.values(sc).map(s => { const seen = []; s.draw = s.plumes.filter(p => { const k = p.b.join(); if (seen.includes(k)) return false; seen.push(k); return true; });
  const qs = s.plumes.filter(p => p.q != null); s.q = qs.length ? qs.reduce((a, p) => a + p.q, 0) : null; s.u = qs.length ? Math.round(Math.sqrt(qs.reduce((a, p) => a + p.u * p.u, 0))) : null; s.origin = qs[0] || s.plumes[0]; return s; });
const MAXQ = Math.max(...SCENES.map(s => s.q || 0));
const sceneAt = (site, t) => SCENES.find(s => s.site === site && s.t === t);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = t => `${+t.slice(8, 10)} ${MON[+t.slice(5, 7) - 1]} ${t.slice(0, 4)}`;
const instName = p => p === 'ISS' ? 'EMIT (ISS)' : 'Tanager-1';
const compass = d => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
const my = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

/* ---------------- Cesium ---------------- */
const C = Cesium;
C.CreditDisplay.cesiumCredit = undefined;
C.RequestScheduler.maximumRequestsPerServer = 18; C.RequestScheduler.maximumRequests = 64;
const viewer = new C.Viewer('cesiumContainer', {
  baseLayer: false,
  terrainProvider: new C.EllipsoidTerrainProvider(),
  animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, infoBox: false, selectionIndicator: false, fullscreenButton: false, vrButton: false,
  useDefaultRenderLoop: LIVE,
  creditContainer: 'credits',
  contextOptions: { webgl: { preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance', alpha: false } },
  msaaSamples: 1,
});
const scene = viewer.scene, camera = scene.camera, globe = scene.globe;
scene.skyAtmosphere.show = true;
scene.skyAtmosphere.brightnessShift = -0.05;
scene.skyAtmosphere.saturationShift = -0.1;
scene.fog.enabled = true; scene.fog.density = 0.00035; scene.fog.minimumBrightness = 0.08;
scene.highDynamicRange = false;
scene.postProcessStages.fxaa.enabled = true;
scene.screenSpaceCameraController.enableInputs = LIVE;
scene.screenSpaceCameraController.minimumZoomDistance = 300;
globe.baseColor = C.Color.fromCssColorString('#0b0e11');
globe.showGroundAtmosphere = true;
viewer.clock.shouldAnimate = false;
viewer.resolutionScale = 1;

/* local ENU frames per site (x east, y north, z up, metres) */
const FRAME = {};
for (const k in SITES) {
  const [w, s, e, n] = SITES[k].b; const lon0 = (w + e) / 2, lat0 = (s + n) / 2;
  const origin = C.Cartesian3.fromDegrees(lon0, lat0, 0);
  const enu = C.Transforms.eastNorthUpToFixedFrame(origin);
  const inv = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
  const toLocal = (lon, lat, h = 0) => C.Matrix4.multiplyByPoint(inv, C.Cartesian3.fromDegrees(lon, lat, h), new C.Cartesian3());
  const R = 6378137, cl = Math.cos(lat0 * Math.PI / 180);
  FRAME[k] = { lon0, lat0, origin, enu, inv, toLocal,
    geo: new C.Cartesian4(lon0 * Math.PI / 180, lat0 * Math.PI / 180, 1 / (R * cl), 1 / R),
    merc: new C.Cartesian4(w * Math.PI / 180, e * Math.PI / 180, my(s), my(n)) };
}
// open on Silivri straight away (or the deep-linked site) instead of Cesium's default whole-globe view
const START_SITE = Q.get('site') === 'sile' ? 'sile' : 'silivri';
if (LIVE) { const F0 = FRAME[START_SITE];
  camera.setView({ destination: C.Cartesian3.fromDegrees(F0.lon0, F0.lat0, 9000), orientation: { heading: 0, pitch: -Math.PI / 2 + 1e-3, roll: 0 } }); }

/* ---------------- plume column texture ---------------- */
const PC = document.createElement('canvas'); PC.width = PC.height = 1024;
function drawColumn(s) {
  const g = PC.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.filter = 'none';
  g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 1024);
  g.globalCompositeOperation = 'lighter'; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.filter = 'blur(12px)';
  const [w, so, e, n] = SITES[s.site].b; const px = lon => (lon - w) / (e - w) * 1024, py = lat => (my(n) - my(lat)) / (my(n) - my(so)) * 1024;
  for (const p of s.draw) g.drawImage(GRAY[p.img], px(p.b[0]), py(p.b[3]), px(p.b[2]) - px(p.b[0]), py(p.b[1]) - py(p.b[3]));
  g.filter = 'none';
  const out = document.createElement('canvas'); out.width = out.height = 1024; out.getContext('2d').drawImage(PC, 0, 0); return out;
}

/* ---------------- volumetric post-process stage ---------------- */
const VOL_FS = `
uniform sampler2D u_depth;
uniform sampler2D u_column;
uniform sampler2D u_hgt;
uniform mat4 u_eyeToLocal;
uniform vec3 u_camLocal;
uniform vec3 u_sunLocal;
uniform vec3 u_box0;
uniform vec3 u_box1;
uniform vec2 u_src;
uniform vec2 u_wind;
uniform vec4 u_geo;
uniform vec4 u_merc;
uniform float u_time;
uniform float u_speed;
uniform float u_gain;
uniform float u_front;
uniform float u_fade;
uniform float u_look;
uniform float u_debug;
uniform float u_skip;
uniform float u_steps;
uniform float u_vex;
uniform float u_stab;
uniform float u_ws;
uniform float u_depthL;
uniform float u_depthN;
in vec2 v_textureCoordinates;

float h31(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float vnoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
  return mix(mix(mix(h31(i),h31(i+vec3(1,0,0)),f.x),mix(h31(i+vec3(0,1,0)),h31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(h31(i+vec3(0,0,1)),h31(i+vec3(1,0,1)),f.x),mix(h31(i+vec3(0,1,1)),h31(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float a=0.5,s=0.0;for(int i=0;i<3;i++){s+=a*vnoise(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=0.5;}return s*1.1428;}
vec3 turbo(float t){t=clamp(t,0.0,1.0);
  vec3 c=vec3(0.13572138+t*(4.6153926+t*(-42.66032258+t*(132.13108234+t*(-152.94239396+t*59.28637943)))),
              0.09140261+t*(2.19418839+t*(4.84296658+t*(-14.18503333+t*(4.27729857+t*2.82956604)))),
              0.1066733+t*(12.64194608+t*(-60.58204836+t*(110.36276771+t*(-89.90310912+t*27.34824973)))));return clamp(c,0.0,1.0);}
vec2 siteUV(vec2 xy){
  float lon=u_geo.x+xy.x*u_geo.z, lat=u_geo.y+xy.y*u_geo.w;
  float u=(lon-u_merc.x)/(u_merc.y-u_merc.x);
  float m=log(tan(0.7853981634+lat*0.5));
  float v=(m-u_merc.z)/(u_merc.w-u_merc.z);
  return vec2(u,v);
}
float column(vec2 xy){
  vec2 uv=siteUV(xy);
  if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0)return 0.0;
  return texture(u_column,uv).r;
}
float terrain(vec2 xy){ vec2 uv=clamp(siteUV(xy),0.0,1.0); return texture(u_hgt,uv).r*1050.0-50.0; }
/* ---- Gaussian plume physics -------------------------------------------------
   Ground-level area source. Vertical spread sigma_z(x) from Briggs rural curves,
   blended across stability classes A..D (u_stab 0..3, from wind speed for a
   daytime overpass), capped by a ~900 m morning mixing height and exaggerated by
   u_vex. The vertical profile is normalised, so integrating density over height
   returns the measured Carbon Mapper column: the data is redistributed, not invented. */
float sigmaZ(float d){
  float x=d+300.0;                                   /* virtual source offset for a landfill-sized area source */
  float sA=0.20*x, sB=0.12*x, sC=0.08*x/sqrt(1.0+0.0002*x), sD=0.06*x/sqrt(1.0+0.0015*x);
  float s=u_stab<1.0?mix(sA,sB,u_stab):u_stab<2.0?mix(sB,sC,u_stab-1.0):mix(sC,sD,u_stab-2.0);
  return min(s,900.0)*u_vex;
}
float downwind(vec2 xy){ return max(dot(xy-u_src,u_wind),0.0); }
/* normalised half-Gaussian with ground reflection (integral over h>=0 is 1) */
float vprof(float h, float sz){ float z=h/sz; return 0.7978846/sz*exp(-0.5*z*z)*step(-20.0,h); }
float envelope(vec3 p, out float sz, out float hn){
  float d=downwind(p.xy); sz=sigmaZ(d);
  float h=p.z-terrain(p.xy); hn=clamp(h/(2.5*sz),0.0,1.0);
  float growth=1.0-smoothstep(u_front-320.0,u_front+320.0,d);
  return vprof(max(h,0.0),sz)*growth*u_fade*exp(-d/9000.0);
}
/* billowy noise: abs-folded fbm gives cauliflower edges, plain fbm the soft body */
float fbm4(vec3 p){float a=0.5,s=0.0;for(int i=0;i<4;i++){s+=a*vnoise(p);p=p*2.07+vec3(1.7,9.2,3.1);a*=0.5;}return s*1.0667;}
float billow(vec3 p){float a=0.5,s=0.0;for(int i=0;i<2;i++){s+=a*abs(2.0*vnoise(p)-1.0);p=p*2.11+vec3(3.1,7.7,1.3);a*=0.5;}return s*1.333;}
const float DENS_A=125.0;
float density(vec3 p, out float col, out float hn){
  /* frozen turbulence carried by the wind (Taylor), slowly evolving; eddies grow with the plume */
  float d=downwind(p.xy); float sz=sigmaZ(d);
  float L=0.55*sz/u_vex+70.0;
  vec2 cw=vec2(-u_wind.y,u_wind.x);
  vec3 adv=vec3(u_wind*u_time*u_speed,0.0);
  vec3 pr=p-adv;
  vec3 q=vec3(dot(pr.xy,u_wind)*0.45, dot(pr.xy,cw), (p.z-terrain(p.xy))*1.35/u_vex)/L + vec3(0.0,0.0,u_time*0.05);
  /* large-scale meander of the whole plume */
  vec2 mw=vec2(vnoise(vec3(pr.xy*0.0012,u_time*0.02)),vnoise(vec3(pr.xy*0.0012+7.3,u_time*0.02)))-0.5;
  col=column(p.xy+mw*(0.35*sz/u_vex+60.0));
  if(col<0.01){hn=0.0;return 0.0;}
  float sz2; float env=envelope(p,sz2,hn);
  if(env<1e-6)return 0.0;
  float n=0.58*fbm4(q)+0.42*billow(q*2.3+vec3(9.1,0.0,4.2));
  float core=clamp(col*1.7,0.0,1.0)*exp(-0.5*hn*hn*5.0); /* 1 in the dense core, 0 at the plume edge */
  float th=0.50-0.38*core;                              /* edges erode into wisps, the core stays solid */
  return col*env*DENS_A*(0.08+0.92*smoothstep(th-0.17,th+0.11,n));
}
float densityCheap(vec3 p){
  float col=column(p.xy); if(col<0.01)return 0.0; float sz,hn; return col*envelope(p,sz,hn)*DENS_A*0.5;
}
/* col = column strength, core = closeness to the source (1 at the source, 0 beyond ~1.6 km) */
vec3 palette(float col, float core){
  if(u_look<0.5){ vec3 a=vec3(0.80,0.80,0.79), b=vec3(0.95,0.76,0.52), c=vec3(0.90,0.45,0.22), r=vec3(0.72,0.16,0.10);
    float t=smoothstep(0.06,0.95,col); vec3 base=t<0.5?mix(a,b,t*2.0):mix(b,c,(t-0.5)*2.0);
    return mix(base, r, core*smoothstep(0.10,0.80,col)*0.62); }
  else if(u_look<1.5){ return turbo(0.1+0.88*col); }
  else { return vec3(0.84,0.85,0.86); }
}
float hg(float mu,float g){ return (1.0-g*g)/pow(max(1e-3,1.0+g*g-2.0*g*mu),1.5); }
/* optical depth toward the sun, 4 samples with growing steps */
float sunDepth(vec3 p){ return (densityCheap(p+u_sunLocal*60.0)*90.0+densityCheap(p+u_sunLocal*180.0)*150.0+densityCheap(p+u_sunLocal*380.0)*250.0+densityCheap(p+u_sunLocal*700.0)*400.0); }
/* eye-space position of the scene depth at this uv (handles Cesium log depth) */
/* ray from the frustum planes (top, bottom, left, right at the near plane): exact, no inverse projection */
vec3 eyePosFromDepth(vec2 uv, float raw, out vec3 dirEC){
  float near=czm_currentFrustum.x;
  vec3 fdir=vec3(mix(czm_frustumPlanes.z,czm_frustumPlanes.w,uv.x), mix(czm_frustumPlanes.y,czm_frustumPlanes.x,uv.y), -near);
  dirEC=normalize(fdir);
  float depthFromCamera=exp2(raw*czm_log2FarDepthFromNearPlusOne)-1.0+near;
  return fdir*(depthFromCamera/near);
}
void main(){
  if(u_skip>0.5){out_FragColor=vec4(0.0);return;}
  vec3 dp=texture(u_depth,v_textureCoordinates).rgb; float raw=dp.r+dp.g/255.0+dp.b/65025.0;
  vec3 dirEC; vec3 posEC=eyePosFromDepth(v_textureCoordinates,raw,dirEC);
  vec3 rd=normalize(mat3(u_eyeToLocal)*dirEC);
  vec3 ro=u_camLocal;
  float tScene=1e12;
  if(raw<1.0){ vec3 pl=(u_eyeToLocal*vec4(posEC,1.0)).xyz; tScene=length(pl-ro); }
  if(u_debug>2.5){ out_FragColor=vec4(dp,1.0); return; }
  if(u_debug>1.5){
    vec3 pl=(u_eyeToLocal*vec4(posEC,1.0)).xyz;
    out_FragColor=vec4(clamp(-posEC.z/20000.0,0.0,1.0), clamp((pl.z-terrain(pl.xy))/1000.0+0.5,0.0,1.0), column(pl.xy), 1.0); return;
  }
  if(u_debug>0.5){
    vec3 pl=(u_eyeToLocal*vec4(posEC,1.0)).xyz;
    float c=column(pl.xy); vec3 col=turbo(c)*0.7*step(0.02,c);
    if(raw>=1.0)col=vec3(0.2,0.0,0.3);
    col=mix(col,vec3(0.0,1.0,0.0),step(abs(pl.z-terrain(pl.xy)),8.0)*0.25);
    out_FragColor=vec4(col,0.6);return;
  }
  float K=0.052*u_gain;
  /* soft shadow of the plume on the ground under it */
  float gshadow=1.0;
  if(raw<1.0&&u_fade>0.001){
    vec3 pg=(u_eyeToLocal*vec4(posEC,1.0)).xyz;
    if(all(greaterThan(pg.xy,u_box0.xy))&&all(lessThan(pg.xy,u_box1.xy))&&column(pg.xy)>0.0)
      gshadow=mix(1.0,exp(-K*0.85*sunDepth(pg+vec3(0.0,0.0,15.0))),0.6);
  }
  vec3 inv=1.0/rd, t0=(u_box0-ro)*inv, t1=(u_box1-ro)*inv;
  vec3 tn3=min(t0,t1), tf3=max(t0,t1);
  float tn=max(max(max(tn3.x,tn3.y),tn3.z),0.0), tf=min(min(min(tf3.x,tf3.y),tf3.z),tScene);
  if(tf<=tn||u_fade<=0.001){out_FragColor=vec4(0.0,0.0,0.0,1.0-gshadow);return;}
  float steps=clamp(u_steps,8.0,128.0);
  float dt=(tf-tn)/steps;
  float jit=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
  float t=tn+dt*jit;
  float mu=dot(rd,u_sunLocal);
  float sunEl=clamp(u_sunLocal.z,0.0,1.0);
  vec3 sunCol=mix(vec3(1.0,0.66,0.42),vec3(1.0,0.95,0.88),smoothstep(0.08,0.55,sunEl))*1.12;
  vec3 skyCol=vec3(0.44,0.56,0.74)*0.62;
  vec3 gndCol=vec3(0.30,0.29,0.24)*0.30;
  vec3 hazeCol=mix(vec3(0.62,0.66,0.72),vec3(0.70,0.76,0.86),sunEl)*0.82;
  float ph=mix(hg(mu,0.62),hg(mu,-0.22),0.28);
  vec3 L=vec3(0.0); float Tr=1.0;
  for(int i=0;i<128;i++){
    if(float(i)>=steps)break;
    vec3 p=ro+rd*t; float col,hn; float dens=density(p,col,hn);
    if(dens>1e-4){
      float st=dens*K;                                   /* extinction */
      float od=K*sunDepth(p);
      /* multiple scattering, 3 octaves (Wrenninge): less extinction, flatter phase each octave */
      float ms=exp(-od)*ph + 0.38*exp(-od*0.45)*mix(ph,1.0,0.6) + 0.16*exp(-od*0.2);
      float core=1.0-smoothstep(100.0,2200.0,length(p.xy-u_src));
      vec3 alb=palette(col,core);
      vec3 amb=skyCol*(0.55+0.45*hn)+gndCol*(1.0-hn);
      vec3 S=alb*0.86*(sunCol*ms*0.95+amb*0.72) + (u_look<0.5?alb*0.10*core*col:vec3(0.0));
      float fogA=1.0-exp(-pow(t*czm_fogDensity,2.0));    /* match Cesium's fog on the tiles */
      S=mix(S,hazeCol,fogA*0.85);
      float a=exp(-st*dt);
      L+=Tr*S*(1.0-a); Tr*=a;
      if(Tr<0.015)break;
    }
    t+=dt; if(t>tf)break;
  }
  vec4 acc=vec4(L,1.0-Tr);
  float k=smoothstep(0.0,0.04,acc.a);
  float aOut=1.0-(1.0-acc.a*k)*gshadow;
  out_FragColor=vec4(acc.rgb*k,aOut);
}`;
const COMP_FS = `
uniform sampler2D colorTexture;
uniform sampler2D u_vol;
in vec2 v_textureCoordinates;
uniform float u_dbg;
void main(){
  vec4 c=texture(colorTexture,v_textureCoordinates);
  vec2 px=1.0/vec2(textureSize(u_vol,0));
  vec4 v=texture(u_vol,v_textureCoordinates)*0.25;
  v+=(texture(u_vol,v_textureCoordinates+vec2(px.x,0.0))+texture(u_vol,v_textureCoordinates-vec2(px.x,0.0))+texture(u_vol,v_textureCoordinates+vec2(0.0,px.y))+texture(u_vol,v_textureCoordinates-vec2(0.0,px.y)))*0.125;
  v+=(texture(u_vol,v_textureCoordinates+px)+texture(u_vol,v_textureCoordinates-px)+texture(u_vol,v_textureCoordinates+vec2(px.x,-px.y))+texture(u_vol,v_textureCoordinates+vec2(-px.x,px.y)))*0.0625;
  if(u_dbg>1.5){out_FragColor=vec4(v.rgb,1.0);return;}
  out_FragColor=vec4(c.rgb*(1.0-v.a)+v.rgb,1.0);
}`;
const colTex = new C.Texture({ context: scene.context, source: drawColumn(SCENES[0]), sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR, wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE }) });
const hgtCanvas = document.createElement('canvas'); hgtCanvas.width = hgtCanvas.height = 48;
{ const g = hgtCanvas.getContext('2d'); const v = Math.round(50 / 1050 * 255); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, 0, 48, 48); }
const hgtTex = new C.Texture({ context: scene.context, source: hgtCanvas, sampler: new C.Sampler({ minificationFilter: C.TextureMinificationFilter.LINEAR, magnificationFilter: C.TextureMagnificationFilter.LINEAR, wrapS: C.TextureWrap.CLAMP_TO_EDGE, wrapT: C.TextureWrap.CLAMP_TO_EDGE }) });
const TERRAIN = {}; // site -> {canvas, hmin, hmax, atSource}
const stage = new C.PostProcessStage({
  name: 'methaneVol', fragmentShader: VOL_FS, textureScale: VOLSCALE, sampleMode: C.PostProcessStageSampleMode.LINEAR,
  uniforms: {
    u_column: colTex, u_hgt: hgtTex, u_depth: 'methaneDepth',
    u_eyeToLocal: new C.Matrix4(), u_camLocal: new C.Cartesian3(), u_sunLocal: new C.Cartesian3(0, 0, 1),
    u_box0: new C.Cartesian3(), u_box1: new C.Cartesian3(), u_src: new C.Cartesian2(), u_wind: new C.Cartesian2(1, 0),
    u_geo: new C.Cartesian4(), u_merc: new C.Cartesian4(),
    u_time: 0, u_speed: 1, u_gain: 1, u_front: 0, u_fade: 0, u_look: LOOK === 'ember' ? 0 : LOOK === 'turbo' ? 1 : 2, u_debug: DEBUG, u_skip: 0, u_steps: STEPS, u_vex: VEX, u_stab: 1.5, u_ws: 3, u_depthL: 20, u_depthN: 1,
  },
});
const CAL_FS = `
uniform sampler2D depthTexture;
in vec2 v_textureCoordinates;
void main(){ float raw=texture(depthTexture,v_textureCoordinates).r; vec3 e=fract(vec3(1.0,255.0,65025.0)*raw); e-=e.yzz*vec3(1.0/255.0,1.0/255.0,0.0); out_FragColor=vec4(e,1.0); }`;
const depthStage = new C.PostProcessStage({ name: 'methaneDepth', fragmentShader: CAL_FS, textureScale: 1, sampleMode: C.PostProcessStageSampleMode.NEAREST });
const compStage = new C.PostProcessStage({ name: 'methaneComp', fragmentShader: COMP_FS, uniforms: { u_vol: 'methaneVol', u_dbg: DEBUG } });
const composite = new C.PostProcessStageComposite({ name: 'methane', stages: [depthStage, stage, compStage], inputPreviousStageTexture: false });
scene.postProcessStages.add(composite);


/* ---------------- source marker (ring clamped to the 3D tiles) ---------------- */
let ring = null, ringId = 'ring';
function makeRing(lon, lat) {
  if (ring) { scene.primitives.remove(ring); ring = null; }
  const outer = [], inner = [];
  for (let i = 0; i < 72; i++) { const a = i / 72 * Math.PI * 2; outer.push(C.Cartesian3.fromDegrees(lon + Math.cos(a) * 0.0030, lat + Math.sin(a) * 0.0022)); inner.push(C.Cartesian3.fromDegrees(lon + Math.cos(a) * 0.0026, lat + Math.sin(a) * 0.0019)); }
  const geom = new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(outer, [new C.PolygonHierarchy(inner)]), vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT });
  ring = scene.primitives.add(new C.GroundPrimitive({
    geometryInstances: new C.GeometryInstance({ geometry: geom, id: ringId, attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(new C.Color(1, 0.69, 0.28, 0.9)) } }),
    appearance: new C.PerInstanceColorAppearance({ flat: true }), classificationType: C.ClassificationType.BOTH, asynchronous: false,
  }));
}
function setRingAlpha(a) { if (!ring || !ring.ready) return; const at = ring.getGeometryInstanceAttributes(ringId); if (at) at.color = C.ColorGeometryInstanceAttribute.toValue(new C.Color(1, 0.69, 0.28, a)); }

/* ---------------- base layer: Google 3D tiles, or the open map ---------------- */
let tileset = null, useGoogle = !!KEY && !FORCE_OPEN;
/* Open terrain: Mapzen Terrain Tiles on AWS Open Data (terrarium PNG, height = R*256 + G + B/256 - 32768), CORS open, no key.
   Served to z15 (about 5 m/px here); deeper tiles are cropped from their z15 ancestor. Sea floor is clamped to 0 so the
   Marmara and Black Sea coasts sit flat under the imagery. */
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';
const HM = 65, TMAX = 15;   // 65 x 65 posts per tile
const demCache = new Map();
function demTile(z, x, y) {
  const id = z + '/' + x + '/' + y;
  if (demCache.has(id)) { const v = demCache.get(id); demCache.delete(id); demCache.set(id, v); return v; }
  const p = fetch(`${TERRARIUM}${id}.png`, { mode: 'cors' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then(createImageBitmap).then(bmp => {
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0); bmp.close && bmp.close();
    const d = g.getImageData(0, 0, c.width, c.height).data; const h = new Float32Array(c.width * c.height);
    for (let i = 0; i < h.length; i++) h[i] = Math.max(0, d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768);
    return { w: c.width, h };
  }).catch(e => { demCache.delete(id); throw e; });
  demCache.set(id, p);
  while (demCache.size > 160) demCache.delete(demCache.keys().next().value);
  return p;
}
// heights for tile (level, x, y) from the terrarium tile at zoom z (an ancestor when z < level); a missing or failed tile
// falls back to coarser zooms (a 404 is open sea, a transient error heals when Cesium reloads the area)
function demHeights(x, y, level, z) {
  const k = 2 ** (level - z), ax = Math.floor(x / k), ay = Math.floor(y / k), ox = (x - ax * k) / k, oy = (y - ay * k) / k;
  return demTile(z, ax, ay).then(({ w, h }) => {
    const out = new Float32Array(HM * HM);
    for (let j = 0; j < HM; j++) {
      const fy = Math.min(w - 1, Math.max(0, (oy + j / (HM - 1) / k) * w - 0.5)); const y0 = Math.floor(fy), y1 = Math.min(w - 1, y0 + 1), ty = fy - y0;
      for (let i = 0; i < HM; i++) {
        const fx = Math.min(w - 1, Math.max(0, (ox + i / (HM - 1) / k) * w - 0.5)); const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
        const a = h[y0 * w + x0] + (h[y0 * w + x1] - h[y0 * w + x0]) * tx, b = h[y1 * w + x0] + (h[y1 * w + x1] - h[y1 * w + x0]) * tx;
        out[j * HM + i] = a + (b - a) * ty;
      }
    }
    return out;
  }, () => z > 0 && level - z < 6 ? demHeights(x, y, level, z - 1) : new Float32Array(HM * HM));
}
function openTerrain() {
  return new C.CustomHeightmapTerrainProvider({
    width: HM, height: HM, tilingScheme: new C.WebMercatorTilingScheme(),
    credit: new C.Credit('Terrain <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen Terrain Tiles on AWS</a> (SRTM, EU-DEM, GMTED, ETOPO1)', true),
    callback: (x, y, level) => demHeights(x, y, level, Math.min(level, TMAX)),
  });
}
async function setupBase() {
  if (useGoogle) {
    const credit = new C.Credit('<span class="gword"><span class="b">G</span><span class="r">o</span><span class="y">o</span><span class="b">g</span><span class="g">l</span><span class="r">e</span></span>', true);
    const resource = new C.Resource({ url: `${C.GoogleMaps.mapTilesApiEndpoint}v1/3dtiles/root.json`, queryParameters: { key: KEY }, credits: [credit] });
    try { tileset = await C.Cesium3DTileset.fromUrl(resource, {
      showCreditsOnScreen: true, maximumScreenSpaceError: SSE, cacheBytes: (LIVE ? 1 : 5) * 1024 * 1024 * 1024, maximumCacheOverflowBytes: (LIVE ? 0.5 : 2) * 1024 * 1024 * 1024,
      enableCollision: false, dynamicScreenSpaceError: false, skipLevelOfDetail: false, preloadFlightDestinations: false, cullRequestsWhileMoving: false, foveatedScreenSpaceError: false, preloadWhenHidden: true,
    }); } catch (e) { window.__fatal = 'Google 3D Tiles failed to load: ' + (e && (e.statusCode || e.message || e)); console.error(window.__fatal); throw e; }
    if (LIVE) { let fails = 0; tileset.tileFailed.addEventListener(() => { if (++fails === 8) toast('Some Google tiles are failing to load. If the map stays blank, the key may be restricted to another website.', 9000); }); }
    scene.primitives.add(tileset);
    globe.show = false;
  } else {
    globe.show = true;
    if (Q.get('terrainsrc') !== 'flat') viewer.terrainProvider = openTerrain();
    globe.maximumScreenSpaceError = LIVE ? 1.5 : 1.2; globe.tileCacheSize = 400; globe.preloadSiblings = true;
    // site crops underneath: same Esri imagery, so they show through wherever a world tile fails to load
    for (const k in SITES) {
      const [w, s, e, n] = SITES[k].b;
      const rect = C.Rectangle.fromDegrees(w, s, e, n);
      const prov = await C.SingleTileImageryProvider.fromUrl(SITES[k].img, { rectangle: rect });
      viewer.imageryLayers.add(new C.ImageryLayer(prov, { rectangle: rect }));
    }
    const esri = new C.UrlTemplateImageryProvider({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maximumLevel: 19,
      credit: new C.Credit('Imagery <a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank" rel="noopener">Esri World Imagery</a> (Esri, Maxar, Earthstar Geographics, GIS User Community)', true),
    });
    let fails = 0; esri.errorEvent.addEventListener(() => { if (++fails === 12 && LIVE) toast('Satellite imagery tiles are not loading here. The landfill areas still show the bundled imagery.', 8000); });
    if (Q.get('imagery') !== 'crops') viewer.imageryLayers.addImageryProvider(esri);
  }
  const mn = $('mapName'); if (mn) mn.textContent = useGoogle ? "Google's photorealistic 3D map" : 'open 3D satellite map';
  const src = $('srcline'); if (src) src.innerHTML = '<b>Methane data</b> Carbon Mapper (Tanager-1, EMIT) · <b>3D map</b> ' + (useGoogle ? 'Google Photorealistic 3D Tiles' : 'Esri World Imagery on open terrain (no key)') + ' · heights and motion modelled · rendered with CesiumJS';
}
/* The live app samples with 4x coarser tiles than the video renderer: a 48 x 48 height grid (about 230 m spacing)
   does not need full-detail meshes, and coarse tiles load several times faster. */
const TSSE = +(Q.get('tsse') || (LIVE ? 1 : 0.25));
async function sampleTerrain(site, p0 = 0.45, p1 = 0.95) {
  if (LIVE) setLoading(`Reading the terrain under ${SITES[site].full}`, p0);
  const [w, so, e, n] = SITES[site].b; const F = FRAME[site]; const N = 48;
  // look straight down from 9 km at quarter resolution, let the tiles load, then read heights from the depth buffer
  setPose({ lon: F.lon0, lat: F.lat0, h: 9000, heading: 0, pitch: -89.9 });
  viewer.resolutionScale = 0.25; viewer.resize(); if (tileset) tileset.maximumScreenSpaceError = SSE * TSSE;
  viewer.render(); viewer.render();
  let k = 0, peak = 1;
  while (!tilesLoaded() && k < 500) {
    await sleep(40); viewer.render(); k++;
    if (LIVE) { const left = pendingTiles(); peak = Math.max(peak, left); setLoading(null, p0 + (p1 - p0) * Math.min(0.97, 0.8 * Math.max(0, 1 - left / peak) + 0.2 * Math.min(1, k / 250))); }
  }
  viewer.render();
  const tPick = performance.now();
  const hs = new Float32Array(N * N).fill(NaN); let valid = 0;
  const win = new C.Cartesian2();
  for (let j = 0; j < N; j++) { const v = (j + 0.5) / N; const m = my(so) + (my(n) - my(so)) * v; const lat = (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180 / Math.PI;
    for (let i = 0; i < N; i++) { const lon = w + (e - w) * (i + 0.5) / N;
      const wc = C.SceneTransforms.worldToWindowCoordinates(scene, C.Cartesian3.fromDegrees(lon, lat, 0), win);
      if (!wc) continue; const pos = scene.pickPosition(wc); if (!pos) continue;
      const h = C.Cartographic.fromCartesian(pos).height; if (Number.isFinite(h) && h > -100 && h < 2500) { hs[j * N + i] = h; valid++; } } }
  let hmin = 1e9, hmax = -1e9, fill = 0;
  for (let idx = 0; idx < N * N; idx++) if (Number.isFinite(hs[idx])) { fill = hs[idx]; break; }
  for (let idx = 0; idx < N * N; idx++) { if (!Number.isFinite(hs[idx])) hs[idx] = fill; else fill = hs[idx]; hmin = Math.min(hmin, hs[idx]); hmax = Math.max(hmax, hs[idx]); }
  // light smoothing (3x3) to hide pick noise
  const sm = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { let a = 0, c = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const jj = j + dj, ii = i + di; if (jj < 0 || jj >= N || ii < 0 || ii >= N) continue; a += hs[jj * N + ii]; c++; } sm[j * N + i] = a / c; }
  const c = document.createElement('canvas'); c.width = c.height = N; const g = c.getContext('2d'); const img = g.createImageData(N, N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const h = sm[j * N + i]; const v = Math.max(0, Math.min(255, Math.round((h + 50) / 1050 * 255))); const o = ((N - 1 - j) * N + i) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255; }
  g.putImageData(img, 0, 0);
  const sIdx = (lon, lat) => { const u = (lon - w) / (e - w), v = (my(lat) - my(so)) / (my(n) - my(so)); return Math.min(N - 1, Math.max(0, Math.floor(v * N))) * N + Math.min(N - 1, Math.max(0, Math.floor(u * N))); };
  TERRAIN[site] = { canvas: c, hmin, hmax, hAt: (lon, lat) => sm[sIdx(lon, lat)], valid, iters: k };
  console.log('terrain ' + site + ' ' + JSON.stringify({ hmin: Math.round(hmin), hmax: Math.round(hmax), valid, of: N * N, iters: k, loaded: tilesLoaded(), pickMs: Math.round(performance.now() - tPick) }));
}
let globeQueue = 0; globe.tileLoadProgressEvent.addEventListener(n => { globeQueue = n; });
function pendingTiles() {
  if (useGoogle) return tileset ? tileset.statistics.numberOfPendingRequests + tileset.statistics.numberOfTilesProcessing : 0;
  return globeQueue;
}
function tilesLoaded() { return (useGoogle ? (tileset && tileset.tilesLoaded) : globe.tilesLoaded); }

/* ---------------- scene state (one overpass) ---------------- */
let cur = null;
const S = { boxRadius: 0 };
let GAIN_MUL = 1;
const baseGain = s => (s.q ? 1.0 + 0.4 * Math.sqrt(s.q / MAXQ) : 1.1);
function sigmaZjs(d, stab) {
  const x = d + 300, sA = 0.20 * x, sB = 0.12 * x, sC = 0.08 * x / Math.sqrt(1 + 0.0002 * x), sD = 0.06 * x / Math.sqrt(1 + 0.0015 * x);
  const v = stab < 1 ? sA + (sB - sA) * stab : stab < 2 ? sB + (sC - sB) * (stab - 1) : sC + (sD - sC) * (stab - 2);
  return Math.min(v, 900);
}
function applyOverpass(s) {
  cur = s; const F = FRAME[s.site];
  colTex.copyFrom({ source: drawColumn(s) });
  let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
  for (const p of s.draw) { const a = F.toLocal(p.b[0], p.b[1]), b = F.toLocal(p.b[2], p.b[3]); bx0 = Math.min(bx0, a.x); bx1 = Math.max(bx1, b.x); by0 = Math.min(by0, a.y); by1 = Math.max(by1, b.y); }
  const src = F.toLocal(s.origin.lon, s.origin.lat);
  const bear = (s.wd + 180) * Math.PI / 180, wx = Math.sin(bear), wy = Math.cos(bear);
  const dmax = Math.hypot(Math.max(Math.abs(bx0 - src.x), Math.abs(bx1 - src.x)), Math.max(Math.abs(by0 - src.y), Math.abs(by1 - src.y)));
  const stab = Math.max(0, Math.min(3, (s.ws - 1.5) / 1.5));
  stage.uniforms.u_stab = stab; stage.uniforms.u_ws = s.ws;
  const ztop = Math.min(3.0 * sigmaZjs(dmax + 1500, stab) * stage.uniforms.u_vex, 4200) + 80;
  const pad = 500; const TR = TERRAIN[s.site] || { hmin: 0, hmax: 0, hAt: () => 0, canvas: null };
  if (TR.canvas) hgtTex.copyFrom({ source: TR.canvas }); else hgtTex.copyFrom({ source: hgtCanvas });
  stage.uniforms.u_box0 = new C.Cartesian3(bx0 - pad, by0 - pad, TR.hmin - 40);
  stage.uniforms.u_box1 = new C.Cartesian3(bx1 + pad, by1 + pad, TR.hmax + ztop);
  S.hSrc = TR.hAt(s.origin.lon, s.origin.lat);
  stage.uniforms.u_src = new C.Cartesian2(src.x, src.y);
  stage.uniforms.u_wind = new C.Cartesian2(wx, wy);
  stage.uniforms.u_geo = F.geo; stage.uniforms.u_merc = F.merc;
  stage.uniforms.u_speed = 10 + s.ws * 2.2;
  stage.uniforms.u_gain = baseGain(s) * GAIN_MUL;
  S.src = src; S.wind = { x: wx, y: wy }; S.dmax = dmax; S.site = s.site; S.F = F;
  S.target = { lon: s.origin.lon, lat: s.origin.lat };
  viewer.clock.currentTime = C.JulianDate.fromIso8601(s.t + ':00Z');
  makeRing(s.origin.lon, s.origin.lat);
  // HUD card
  const site = SITES[s.site];
  $('cSite').textContent = site.name + ' · ' + site.side; $('cName').textContent = site.full;
  $('cDate').textContent = fmtDate(s.t) + ' · ' + s.t.slice(11) + ' UTC'; $('cSat').textContent = instName(s.plat);
  $('cWind').textContent = s.ws.toFixed(1) + ' m/s from ' + compass(s.wd);
  if (s.q != null) { $('cBig').style.display = ''; $('cUnc').textContent = '± ' + (s.u / 1000).toFixed(1) + ' t/h · ' + s.draw.length + (s.draw.length > 1 ? ' plumes' : ' plume'); }
  else { $('cBig').style.display = 'none'; $('cUnc').innerHTML = '<span class="withheld">Rate withheld</span>'; }
}

/* log-depth decode parameters from the frustum Cesium rendered with (set after the render that wrote the depth) */
const CAL = { L: 20, N: 0.1 };
function calibrateDepth() {
  const view = scene.view || scene._view; const fl = view && view.frustumCommandsList; if (!fl || !fl.length) return CAL;
  const f = fl[0]; CAL.N = f.near; CAL.L = Math.log2(f.far - f.near + 1); return CAL;
}
/* per-frame uniforms depending on the camera */
const scratch = { m: new C.Matrix4(), v: new C.Cartesian3(), sun: new C.Cartesian3() };
function updateCameraUniforms(time) {
  const F = S.F; if (!F) return;
  const eyeToLocal = C.Matrix4.multiply(F.inv, camera.inverseViewMatrix, scratch.m);
  stage.uniforms.u_eyeToLocal = C.Matrix4.clone(eyeToLocal, new C.Matrix4());
  stage.uniforms.u_camLocal = C.Matrix4.multiplyByPoint(F.inv, camera.positionWC, new C.Cartesian3());
  // sun direction in local frame
  const icrf = C.Transforms.computeIcrfToFixedMatrix(time);
  let sunWC = C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time, scratch.sun);
  if (icrf) sunWC = C.Matrix3.multiplyByVector(icrf, sunWC, sunWC);
  const sunL = C.Matrix4.multiplyByPointAsVector(F.inv, sunWC, new C.Cartesian3());
  C.Cartesian3.normalize(sunL, sunL);
  if (sunL.z < 0.15) { sunL.z = 0.15; C.Cartesian3.normalize(sunL, sunL); }
  stage.uniforms.u_sunLocal = sunL;
}

/* ---------------- camera poses ---------------- */
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function setPose(p) { camera.setView({ destination: C.Cartesian3.fromDegrees(p.lon, p.lat, p.h), orientation: { heading: rad(p.heading), pitch: rad(p.pitch), roll: 0 } }); }
function readPose() { const c = camera.positionCartographic; return { lon: deg(c.longitude), lat: deg(c.latitude), h: c.height, heading: deg(camera.heading), pitch: deg(camera.pitch) }; }
function orbitPose(target, headingDeg, pitchDeg, range, targetH = 120) {
  camera.lookAt(C.Cartesian3.fromDegrees(target.lon, target.lat, targetH), new C.HeadingPitchRange(rad(headingDeg), rad(pitchDeg), range));
  camera.lookAtTransform(C.Matrix4.IDENTITY);
  return readPose();
}
const ease = x => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
const easeInOut = x => { x = Math.max(0, Math.min(1, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) { let d = ((b - a + 540) % 360) - 180; return a + d * t; }
function lerpPose(a, b, t, bump = 0, via = null) {
  let lon, lat;
  if (via) { const u = 1 - t; lon = u * u * a.lon + 2 * u * t * via.lon + t * t * b.lon; lat = u * u * a.lat + 2 * u * t * via.lat + t * t * b.lat; }
  else { lon = lerp(a.lon, b.lon, t); lat = lerp(a.lat, b.lat, t); }
  return { lon, lat, h: lerp(a.h, b.h, t) + bump * Math.sin(Math.PI * t), heading: via ? (t < 0.5 ? lerpAngle(a.heading, via.heading, t * 2) : lerpAngle(via.heading, b.heading, (t - 0.5) * 2)) : lerpAngle(a.heading, b.heading, t), pitch: lerp(a.pitch, b.pitch, t) };
}

/* ---------------- timeline ---------------- */
const SHOW = {
  silivri: ['2025-11-25T09:52', '2026-02-15T10:00', '2026-04-26T10:10'],
  sile:    ['2025-09-02T09:40', '2025-11-04T09:49', '2026-04-12T10:13'],
};
const REEL = !LIVE && Q.get('reel') === '1';       // 9:16 Instagram cut, rendered with render.py --reel
const T = { intro: 7, fly1: 6, hold: 6, fly2: 8, outro: 7 };
T.silStart = T.intro + T.fly1;                 // 13
T.silEnd = T.silStart + 3 * T.hold;            // 31
T.sileStart = T.silEnd + T.fly2;               // 39
T.sileEnd = T.sileStart + 3 * T.hold;          // 57
T.total = T.sileEnd + T.outro;                 // 64
/* Reel: hard cuts between the two sites, each framed from behind the source looking downwind so the plume
   streams up a portrait frame. Captions use measured overpass rates and the UCLA averages reported by the
   Guardian (5 Oct 2026). */
const RT = { sil: 0, sile: 12, out: 18.5, total: 24 };
window.__total = REEL ? RT.total : T.total; window.__fps = FPS;

const INTRO_A = { lon: 28.905, lat: 40.915, h: 13500, heading: 42, pitch: -31 };
const INTRO_B = { lon: 28.935, lat: 40.935, h: 12000, heading: 38, pitch: -30 };
const VIA_CITY = { lon: 29.00, lat: 41.02, h: 11000, heading: 62, pitch: -34 };
const ORB = { silivri: { h0: 0, range0: 0, range1: 0, pitch0: -30, pitch1: -24, sweep: -95 }, sile: { h0: 0, range0: 0, range1: 0, pitch0: -30, pitch1: -24, sweep: -95 } };
const SITEV = {};
for (const site in SHOW) {
  const F = FRAME[site]; let dmaxMax = 0, wx = 0, wy = 0, sx = 0, sy = 0, n = 0;
  for (const t of SHOW[site]) { const s = sceneAt(site, t); let bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
    for (const p of s.draw) { const a = F.toLocal(p.b[0], p.b[1]), b = F.toLocal(p.b[2], p.b[3]); bx0 = Math.min(bx0, a.x); bx1 = Math.max(bx1, b.x); by0 = Math.min(by0, a.y); by1 = Math.max(by1, b.y); }
    const src = F.toLocal(s.origin.lon, s.origin.lat); const bear = (s.wd + 180) * Math.PI / 180;
    const dmax = Math.hypot(Math.max(Math.abs(bx0 - src.x), Math.abs(bx1 - src.x)), Math.max(Math.abs(by0 - src.y), Math.abs(by1 - src.y)));
    dmaxMax = Math.max(dmaxMax, dmax); wx += Math.sin(bear); wy += Math.cos(bear); sx += src.x; sy += src.y; n++; }
  const off = 0.28 * dmaxMax / Math.max(1e-6, Math.hypot(wx / n, wy / n)) * 1.0; // mean wind direction, scaled
  const tx = sx / n + (wx / n) * off, ty = sy / n + (wy / n) * off;
  const R = 6378137;
  SITEV[site] = { dmaxMax, target: { lon: F.lon0 + tx / (R * Math.cos(rad(F.lat0))) * 180 / Math.PI, lat: F.lat0 + ty / R * 180 / Math.PI }, range: 1.15 * dmaxMax + 3200 };
  ORB[site].range0 = SITEV[site].range * 1.12; ORB[site].range1 = SITEV[site].range * 0.9;
}

function orbitParams(site, u) { // u in 0..1 over the whole site hold
  const o = ORB[site]; return { heading: o.h0 + o.sweep * u, pitch: lerp(o.pitch0, o.pitch1, u), range: lerp(o.range0, o.range1, easeInOut(u)) };
}
function orbitTarget() { return SITEV[S.site].target; }
function orbitTargetH() { return (S.hSrc || 0) + 120; }

function ensureOverpass(site, idx) { const s = sceneAt(site, SHOW[site][idx]); if (cur !== s) applyOverpass(s); return s; }
function orbitHeading0(site) { // look roughly across the wind so the plume stretches across frame
  const s = sceneAt(site, SHOW[site][0]); return (s.wd + 180 + 75) % 360;
}
ORB.silivri.h0 = orbitHeading0('silivri'); ORB.sile.h0 = orbitHeading0('sile');

let hud = { brand: 0, tag: 0, title: 0, card: 0, outro: 0, num: 0 };
function setHud(h) {
  $('brand').style.opacity = h.brand; $('tag').style.opacity = h.tag; $('title').style.opacity = h.title; $('card').style.opacity = h.card; $('outro').style.opacity = h.outro;
  $('title').style.transform = `translateY(${(1 - h.title) * 18}px)`; $('card').style.transform = `translateY(${(1 - h.card) * 14}px)`;
  if (cur && cur.q != null) $('cNum').textContent = (cur.q * h.num / 1000).toFixed(1);
}

function reelShot(site, lt, dur, pre = 0) {
  ensureOverpass(site, 0);                           // each site's peak overpass
  const u = Math.min(1, lt / dur), s = cur, R0 = SITEV[site].range, z = site === 'sile' ? 0.8 : 1;
  const heading = (s.wd + 180 + 22 - 44 * easeInOut(u) + 360) % 360;   // behind the source, drifting across
  const pose = orbitPose(orbitTarget(), heading, lerp(-36, -29, u), lerp(R0 * 0.95 * z, R0 * 0.74 * z, easeInOut(u)), orbitTargetH());
  const b = lt + pre;                                // pre: start part-way into the bloom so frame 1 already shows gas
  return { pose, fade: pre ? 1 : ease(lt / 0.45), front: 400 + Math.min(1, b / 2.4) * (S.dmax * 1.3 + 2500), simT: b * 1.15 };
}
function capAlpha(t, a, b) { return Math.min(ease((t - a) / 0.35), 1 - ease((t - (b - 0.3)) / 0.3)); }
function applyReel(t) {
  let r;
  if (t < RT.sile) r = reelShot('silivri', t, RT.sile, 0.9);
  else if (t < RT.out) r = reelShot('sile', t - RT.sile, RT.out - RT.sile + 2);
  else {
    // pull back around the plume (same target), so the source stays centred under the closing captions
    const lt = t - RT.out, u = easeInOut(lt / (RT.total - RT.out)), dur = RT.out - RT.sile + 2, u0 = (RT.out - RT.sile) / dur;
    ensureOverpass('sile', 0); const R0 = SITEV.sile.range * 0.8;
    const heading = (cur.wd + 180 + 22 - 44 * easeInOut(u0) - 10 * u + 360) % 360;
    const pose = orbitPose(orbitTarget(), heading, lerp(lerp(-36, -29, u0), -40, u), lerp(lerp(R0 * 0.95, R0 * 0.74, easeInOut(u0)), R0 * 1.25, u), orbitTargetH());
    r = { pose, fade: 1, front: 1e6, simT: (RT.out - RT.sile) * 1.15 + lt * 1.15 };
  }
  setPose(r.pose);
  stage.uniforms.u_fade = r.fade; stage.uniforms.u_front = r.front; stage.uniforms.u_time = r.simT;
  setRingAlpha(0.45 * r.fade);
  setHud({ brand: 0, tag: 0, title: 0, card: 0, outro: 0, num: 1 });
  const show = (id, a) => { const el = $(id); el.style.opacity = a; el.style.transform = `translateY(${(1 - a) * 22}px)`; };
  show('rc1', capAlpha(t, 0.15, 3.0)); $('rc1b').style.opacity = ease((t - 1.2) / 0.35);
  show('rc2', capAlpha(t, 3.2, 7.4));
  show('rc3', capAlpha(t, 7.6, 11.9));
  show('rc4', capAlpha(t, 12.3, 18.4));
  show('rc5', capAlpha(t, 18.9, RT.total + 1)); $('rc5b').style.opacity = ease((t - 20.2) / 0.35); $('rc5c').style.opacity = ease((t - 21.6) / 0.35);
  updateCameraUniforms(viewer.clock.currentTime);
}
function applyTime(t) {
  if (REEL) return applyReel(t);
  let plumeFade = 0, front = 0, simT = t, h = { brand: 0, tag: 0, title: 0, card: 0, outro: 0, num: 1 };
  let ringA = 0;
  const siteHold = (site, start) => {
    const lt = t - start, idx = Math.min(2, Math.floor(lt / T.hold)), lt2 = lt - idx * T.hold;
    ensureOverpass(site, idx);
    const fadeIn = ease(lt2 / 0.9), fadeOut = 1 - ease((lt2 - (T.hold - 0.7)) / 0.7);
    plumeFade = Math.min(fadeIn, idx === 2 ? 1 : fadeOut);
    front = 400 + Math.min(1, lt2 / 3.2) * (S.dmax * 1.3 + 2500); // bloom downwind
    simT = (start + idx * T.hold) * 0 + lt2 * 1.0 + idx * 37.0;
    const p = orbitParams(site, lt / (3 * T.hold)); const pose = orbitPose(orbitTarget(), p.heading, p.pitch, p.range, orbitTargetH());
    h.card = Math.min(ease((lt2 - 0.3) / 0.7), idx === 2 ? 1 : 1 - ease((lt2 - (T.hold - 0.5)) / 0.4));
    h.num = ease((lt2 - 0.5) / 1.8); h.brand = 1; h.tag = 1;
    ringA = 0.55 + 0.35 * Math.sin(t * 2.6);
    return pose;
  };
  let pose;
  if (t < T.intro) {
    ensureOverpass('silivri', 0); pose = lerpPose(INTRO_A, INTRO_B, easeInOut(t / T.intro));
    h.title = Math.min(ease((t - 0.6) / 1.2), 1 - ease((t - (T.intro - 1.2)) / 0.9)); h.brand = ease((t - 0.3) / 1); h.tag = ease((t - 0.3) / 1);
  } else if (t < T.silStart) {
    ensureOverpass('silivri', 0); const u = (t - T.intro) / T.fly1;
    const p0 = orbitParams('silivri', 0); const end = orbitPose(orbitTarget(), p0.heading, p0.pitch, p0.range, orbitTargetH());
    pose = lerpPose(INTRO_B, end, easeInOut(u), 4500);
    h.brand = 1; h.tag = 1;
    if (t > T.silStart - 1.6) { plumeFade = ease((t - (T.silStart - 1.6)) / 1.0); front = 400 + Math.min(1, (t - (T.silStart - 1.6)) / 3.2) * (S.dmax * 1.3 + 2500); simT = t - (T.silStart - 1.6); ringA = 0.6 * plumeFade; }
    setPose(pose);
    if (t > T.silStart - 1.6) { const c = Math.min(1, (t - (T.silStart - 1.6)) / 1.0); stage.uniforms.u_fade = plumeFade; }
  } else if (t < T.silEnd) {
    pose = siteHold('silivri', T.silStart);
    // keep simT continuous within the overpass: handled in siteHold
    if (t >= T.silStart && t < T.silStart + 1.6) { simT = (t - (T.silStart - 1.6)); front = 400 + Math.min(1, (t - (T.silStart - 1.6)) / 3.2) * (S.dmax * 1.3 + 2500); plumeFade = 1; }
  } else if (t < T.sileStart) {
    const u = (t - T.silEnd) / T.fly2;
    if (u < 0.5) { ensureOverpass('silivri', 2); } else { ensureOverpass('sile', 0); }
    // start pose: end of Silivri orbit; end pose: start of Sile orbit (computed in the right frames)
    const sSil = sceneAt('silivri', SHOW.silivri[2]); const sSile = sceneAt('sile', SHOW.sile[0]);
    if (!S.poseSilEnd) { applyOverpass(sSil); const p = orbitParams('silivri', 1); S.poseSilEnd = orbitPose(orbitTarget(), p.heading, p.pitch, p.range, orbitTargetH()); }
    if (!S.poseSileStart) { applyOverpass(sSile); const p = orbitParams('sile', 0); S.poseSileStart = orbitPose(orbitTarget(), p.heading, p.pitch, p.range, orbitTargetH()); if (u < 0.5) applyOverpass(sSil); }
    pose = lerpPose(S.poseSilEnd, S.poseSileStart, easeInOut(u), 9000, VIA_CITY);
    h.brand = 1; h.tag = 1;
    if (u < 0.5) { plumeFade = 1 - ease((t - T.silEnd) / 0.9); front = 1e6; simT = (T.hold) + 2 * 37.0 + (t - T.silEnd); }
    else if (t > T.sileStart - 1.6) { plumeFade = ease((t - (T.sileStart - 1.6)) / 1.0); front = 400 + Math.min(1, (t - (T.sileStart - 1.6)) / 3.2) * (S.dmax * 1.3 + 2500); simT = t - (T.sileStart - 1.6); ringA = 0.6 * plumeFade; }
  } else if (t < T.sileEnd) {
    pose = siteHold('sile', T.sileStart);
    if (t < T.sileStart + 1.6) { simT = (t - (T.sileStart - 1.6)); front = 400 + Math.min(1, (t - (T.sileStart - 1.6)) / 3.2) * (S.dmax * 1.3 + 2500); plumeFade = 1; }
  } else {
    ensureOverpass('sile', 2); const u = (t - T.sileEnd) / T.outro;
    if (!S.poseSileEnd) { const p = orbitParams('sile', 1); S.poseSileEnd = orbitPose(orbitTarget(), p.heading, p.pitch, p.range, orbitTargetH()); }
    const far = { lon: S.poseSileEnd.lon, lat: S.poseSileEnd.lat, h: S.poseSileEnd.h + 7000, heading: S.poseSileEnd.heading + 25, pitch: -42 };
    pose = lerpPose(S.poseSileEnd, far, easeInOut(u));
    plumeFade = 1 - ease((t - T.sileEnd - 0.2) / 2.0); front = 1e6; simT = T.hold + 2 * 37.0 + (t - T.sileEnd);
    h.brand = 1; h.tag = 1; h.outro = ease((t - T.sileEnd - 1.0) / 1.2); ringA = 0.5 * plumeFade;
  }
  setPose(pose);
  stage.uniforms.u_fade = plumeFade; stage.uniforms.u_front = front; stage.uniforms.u_time = simT;
  setRingAlpha(ringA);
  setHud(h);
  updateCameraUniforms(viewer.clock.currentTime);
  if (DEBUG) { $('debug').style.display = 'block'; $('debug').textContent = `t=${t.toFixed(2)} pose=${JSON.stringify(pose, (k, v) => typeof v === 'number' ? +v.toFixed(4) : v)}\nfade=${plumeFade.toFixed(2)} front=${front.toFixed(0)} cur=${cur && cur.t}`; }
}

/* ---------------- frame API ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
window.__ready = (async () => {
  if (LIVE) setLoading(useGoogle ? 'Connecting to Google Photorealistic 3D Tiles' : 'Connecting to the open 3D map', 0.38);
  try { await setupBase(); }
  catch (e) {
    if (!LIVE) throw e;
    const code = e && e.statusCode;
    showKeyGate(`Google rejected this key${code ? ' (HTTP ' + code + ')' : ''}. Check that the Map Tiles API is enabled for its project, billing is active, and any website restriction allows ${location.origin}. Or continue on the open map, which needs no key.`);
    await new Promise(() => {});
  }
  if (Q.get('terrain') !== '0') {
    // the live app reads only the site it opens on; the other site's terrain is read the first time it is visited
    if (LIVE) await sampleTerrain(START_SITE);
    else for (const site of ['silivri', 'sile']) await sampleTerrain(site);
    viewer.resolutionScale = 1; viewer.resize(); if (tileset) tileset.maximumScreenSpaceError = SSE; viewer.render();
  }
  applyOverpass(sceneAt('silivri', SHOW.silivri[0]));
  if (LIVE) { startLive(); return true; }
  applyTime(0);
  for (let i = 0; i < 3; i++) { viewer.render(); await sleep(30); }
  return true;
})();
window.__frame = async function (i, maxIter = 400) {
  const t = i / FPS;
  const t0 = performance.now();
  applyTime(t);
  // tile-loading loop with the tileset hidden (preloadWhenHidden keeps requests and decoding going),
  // so the CPU goes to decoding rather than rasterizing; then show and render. The shown render can
  // reveal a few more tiles to load, so repeat up to 3 rounds.
  let n = 0, m = 0;
  for (let round = 0; round < 3; round++) {
    stage.uniforms.u_skip = 1;
    if (tileset) tileset.show = false;
    viewer.render();
    while (!tilesLoaded() && n < maxIter) { await sleep(150); viewer.render(); n++; }
    if (tileset) tileset.show = true;
    stage.uniforms.u_skip = window.__forceSkip ? 1 : 0;
    updateCameraUniforms(viewer.clock.currentTime);
    viewer.render(); m++;
    if (tilesLoaded() || n >= maxIter) break;
  }
  const t2 = performance.now();
  return { t, iters: n, iters2: m, loaded: tilesLoaded(), ms: Math.round(t2 - t0), stats: useGoogle && tileset ? { sel: tileset.statistics.selected, pend: tileset.statistics.numberOfPendingRequests, proc: tileset.statistics.numberOfTilesProcessing, mem: Math.round(tileset.totalMemoryUsageInBytes / 1048576) } : null };
};
window.__bench = function (n = 3) { const out = {}; for (const skip of [1, 0]) { stage.uniforms.u_skip = skip; const t0 = performance.now(); for (let i = 0; i < n; i++) viewer.render(); scene.context._gl.finish(); out['skip' + skip] = ((performance.now() - t0) / n).toFixed(0) + ' ms'; } return out; };
window.__time = async function (t) { return window.__frame(Math.round(t * FPS)); };

/* ================= interactive app ================= */
function setLoading(msg, p) {
  const el = $('loading'); if (!el) return;
  if (el.style.display === 'none' || el.classList.contains('out')) { el.classList.remove('out'); el.style.display = 'flex'; }
  if (msg != null) $('loadMsg').textContent = msg;
  if (p != null && p > loadP) { loadP = p; $('loadBar').style.width = (p * 100).toFixed(1) + '%'; }
}
function hideLoading() {
  const el = $('loading'); if (!el) return;
  loadP = 1; $('loadBar').style.width = '100%';
  el.classList.add('out'); clearTimeout(hideLoading._t);
  hideLoading._t = setTimeout(() => { if (el.classList.contains('out')) { el.style.display = 'none'; el.classList.remove('soft'); loadP = 0; $('loadBar').style.width = '0%'; } }, 650);
}
// terrain for a site the live app has not visited yet: a short, see-through loading step
const terrainJobs = {};
function ensureTerrain(site) {
  if (TERRAIN[site] || Q.get('terrain') === '0') return Promise.resolve();
  if (!terrainJobs[site]) terrainJobs[site] = (async () => {
    LIVESTATE.busy = true; LIVESTATE.flying = true; camera.cancelFlight(); camera.lookAtTransform(C.Matrix4.IDENTITY);
    $('loading').classList.add('soft'); loadP = 0;
    await sampleTerrain(site, 0.05, 0.95);
    viewer.resolutionScale = LIVESTATE.scale; viewer.resize(); if (tileset) tileset.maximumScreenSpaceError = SSE;
    LIVESTATE.busy = false; LIVESTATE.flying = false; hideLoading();
  })();
  return terrainJobs[site];
}
function showKeyGate(err) { $('loading').style.display = 'none'; $('keyGate').style.display = 'flex'; $('keyErr').textContent = err || ''; $('keyErr').hidden = !err; setTimeout(() => $('keyInput').focus(), 50); }
function toast(msg, ms = 2600) { const el = $('toast'); if (!el) return; el.textContent = msg; el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms); }
const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const LIVESTATE = {
  tour: false, tourT: 0, tourPaused: false, seeking: false,
  orbit: !reduceMotion, motion: !reduceMotion, age: 0, simT: 0, last: null, flying: false,
  speed: 1, quality: 'auto', steps: STEPS, scale: 1, ema: 1 / 60, lastAdapt: 0, goodRuns: 0, badRuns: 0, frames: 0, fpsT0: 0, fps: 0, liveSince: 0, busy: false, pan: new Set(),
};
const LOOKS = ['ember', 'turbo', 'natural'];
const lookIndex = v => { const i = LOOKS.indexOf(v === 'smoke' ? 'natural' : v); return Math.max(0, i); };
const fmtClock = x => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
function chapterAt(t) { return t < T.intro ? 'Istanbul' : t < T.silStart ? 'To Silivri' : t < T.silEnd ? 'Silivri' : t < T.sileStart ? 'Across the Bosphorus' : t < T.sileEnd ? 'Şile' : 'Closing'; }

function targetWC() { return C.Cartesian3.fromDegrees(orbitTarget().lon, orbitTarget().lat, orbitTargetH()); }
function orbitHPR(site) { const p = orbitParams(site, 0.3); return new C.HeadingPitchRange(rad(p.heading), rad(p.pitch), p.range); }
function flyToSite(site, duration = 2.6) {
  const tgt = targetWC(); const hpr = orbitHPR(site); LIVESTATE.flying = true;
  camera.flyToBoundingSphere(new C.BoundingSphere(tgt, 1), { offset: hpr, duration: reduceMotion ? 0 : duration,
    complete: () => { camera.lookAt(tgt, hpr); LIVESTATE.flying = false; }, cancel: () => { LIVESTATE.flying = false; } });
}
async function selectOverpass(s, fly) {
  if (LIVE && !TERRAIN[s.site]) { await ensureTerrain(s.site); fly = true; }
  const siteChanged = !cur || cur.site !== s.site;
  applyOverpass(s);
  LIVESTATE.age = reduceMotion ? 99 : 0;   // bloom always plays (or is instant); Motion only freezes the drift
  LIVESTATE.simT = Math.random() * 100;
  buildPanel(); syncURL();
  if (fly || siteChanged) flyToSite(s.site, siteChanged ? 3.2 : 1.8);
}
function siteList(site) { return SCENES.filter(x => x.site === site).sort((a, b) => b.t.localeCompare(a.t)); }
function peakOf(site) { const l = siteList(site); return l.reduce((a, c) => (c.q || 0) > (a.q || 0) ? c : a, l[0]); }
function stepOverpass(d) { const l = siteList(cur.site); const i = l.indexOf(cur); const j = Math.max(0, Math.min(l.length - 1, i + d)); if (j !== i) { selectOverpass(l[j], false); const b = $('ovList').children[j]; if (b) b.scrollIntoView({ block: 'nearest' }); } }
function buildPanel() {
  const site = S.site || 'silivri';
  document.querySelectorAll('[data-site]').forEach(b => b.setAttribute('aria-pressed', b.dataset.site === site));
  const list = siteList(site);
  const el = $('ovList'); el.innerHTML = '';
  for (const x of list) {
    const b = document.createElement('button'); b.className = 'ov'; b.setAttribute('role', 'listitem');
    if (x === cur) b.setAttribute('aria-current', 'true');
    const rate = x.q == null ? 'rate withheld by Carbon Mapper' : `${(x.q / 1000).toFixed(1)} tonnes of methane per hour`;
    b.setAttribute('aria-label', `${fmtDate(x.t)}, ${instName(x.plat)}, ${rate}`);
    b.innerHTML = `<span class="d">${fmtDate(x.t)}<small>${instName(x.plat)}</small></span><span class="bar" aria-hidden="true"><i style="width:${x.q ? Math.max(3, x.q / MAXQ * 100) : 0}%"></i></span><span class="q${x.q == null ? ' none' : ''}">${x.q == null ? 'withheld' : (x.q / 1000).toFixed(1) + ' t/h'}</span>`;
    b.onclick = () => selectOverpass(x, false); el.appendChild(b);
  }
  const rated = list.filter(x => x.q != null).map(x => x.q);
  $('stats').innerHTML = `<div><b>${list.length}</b><span>overpasses</span></div><div><b>${(Math.max(...rated) / 1000).toFixed(1)}</b><span>peak t/h</span></div><div><b>${(rated.reduce((a, b) => a + b, 0) / rated.length / 1000).toFixed(1)}</b><span>mean t/h</span></div>`;
  $('orbitBtn').setAttribute('aria-pressed', LIVESTATE.orbit); $('motionBtn').setAttribute('aria-pressed', LIVESTATE.motion);
  if (cur) $('psub').textContent = `${SITES[cur.site].name} · ${fmtDate(cur.t)}`;
  drawChart();
}
/* timeline of every detection, Jun 2024 to today (both sites) */
const SERIES = { silivri: 'var(--series-1)', sile: 'var(--series-2)' };
function drawChart() {
  const el = $('chart'); if (!el) return;
  const W = Math.max(240, el.clientWidth || 308), H = 132, L = 30, R = 10, Tp = 26, B = 22;
  const x0 = Date.UTC(2024, 4, 15), x1 = Date.now(), yMax = 13000;
  const X = t => L + (Date.parse(t + ':00Z') - x0) / (x1 - x0) * (W - L - R);
  const Y = q => Tp + (1 - q / yMax) * (H - Tp - B);
  const yb = Y(0);
  let g = '';
  for (const v of [0, 6000, 12000]) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid${v ? '' : ' base'}"/><text x="${L - 6}" y="${Y(v) + 3.5}" class="ax" text-anchor="end">${v / 1000}</text>`;
  for (const yr of [2025, 2026]) { const xx = L + (Date.UTC(yr, 0, 1) - x0) / (x1 - x0) * (W - L - R); g += `<line x1="${xx}" x2="${xx}" y1="${yb}" y2="${yb + 4}" class="tick"/><text x="${xx}" y="${H - 6}" class="ax" text-anchor="middle">${yr}</text>`; }
  g += `<line x1="${W - R}" x2="${W - R}" y1="${Tp - 4}" y2="${yb}" class="today"/><text x="${W - R}" y="${H - 6}" class="ax" text-anchor="end">today</text>`;
  g += `<text x="${L - 6}" y="${Tp - 10}" class="ax" text-anchor="end">t/h</text>`;
  let dots = '';
  const order = [...SCENES].sort((a, b) => (a.site === S.site) - (b.site === S.site));   // current site drawn on top
  for (const sc of order) {
    const cx = X(sc.t), cy = sc.q == null ? yb : Y(sc.q), sel = sc === cur, dim = sc.site !== S.site;
    const r = sel ? 6 : 4.5, col = SERIES[sc.site];
    dots += sc.q == null
      ? `<circle cx="${cx}" cy="${cy}" r="${r - 0.5}" class="dot hollow${dim ? ' dim' : ''}" style="stroke:${col}"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${r}" class="dot${dim ? ' dim' : ''}" style="fill:${col}"/>`;
    if (sel) dots += `<circle cx="${cx}" cy="${cy}" r="${r + 3}" class="selring"/>`;
    dots += `<circle cx="${cx}" cy="${cy}" r="11" class="hit" data-k="${sc.site}|${sc.t}"/>`;
  }
  const legend = `<div class="lg"><span><i style="background:var(--series-1)"></i>Silivri</span><span><i style="background:var(--series-2)"></i>Şile</span><span><i class="hollow"></i>rate withheld</span></div>`;
  const n = SCENES.length, rated = SCENES.filter(x => x.q != null).length;
  el.innerHTML = legend + `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Methane emission rate per overpass, June 2024 to today: ${n} overpasses, ${rated} with a published rate. Peak 12.0 tonnes per hour at Silivri on 25 Nov 2025. The overpass list below has every value.">${g}${dots}</svg><div class="tip" hidden></div>`;
  const tip = el.querySelector('.tip');
  el.querySelectorAll('.hit').forEach(h => {
    const sc = SCENES.find(x => x.site + '|' + x.t === h.dataset.k);
    h.addEventListener('pointerenter', () => {
      tip.innerHTML = `<b>${fmtDate(sc.t)}</b> · ${SITES[sc.site].name}<br>${sc.q == null ? 'rate withheld' : (sc.q / 1000).toFixed(1) + ' ± ' + (sc.u / 1000).toFixed(1) + ' t/h'} · ${instName(sc.plat)}`;
      tip.hidden = false; const cx = +h.getAttribute('cx'), cy = +h.getAttribute('cy') + 22;
      const tw = tip.offsetWidth; tip.style.left = Math.max(0, Math.min(W - tw, cx - tw / 2)) + 'px';
      tip.style.top = (cy - tip.offsetHeight - 14 < 20 ? cy + 12 : cy - tip.offsetHeight - 14) + 'px';
    });
    h.addEventListener('pointerleave', () => { tip.hidden = true; });
    h.addEventListener('click', () => { if (sc !== cur) selectOverpass(sc, sc.site !== S.site); });
  });
}
function shareURL() { const u = new URL(location.origin + location.pathname); if (cur) { u.searchParams.set('site', cur.site); u.searchParams.set('ov', cur.t); } const look = +stage.uniforms.u_look; if (look) u.searchParams.set('look', LOOKS[look]); return u.toString(); }
function syncURL() { const u = new URL(shareURL()); for (const k of ['nokey', 'base', 'debug', 'stats']) if (Q.get(k)) u.searchParams.set(k, Q.get(k)); history.replaceState(null, '', u); }

/* camera guard: keep the orbit camera above the ground near the target */
const MIN_UP = 260;
/* Arrow keys slide the map: up/down move along the view direction, left/right across it, at a speed that
   scales with the camera's distance so it feels the same zoomed in or out. The camera keeps its angle. */
const PAN_KEYS = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
function panPivot() {
  if (!C.Matrix4.equals(camera.transform, C.Matrix4.IDENTITY)) return C.Matrix4.getTranslation(camera.transform, new C.Cartesian3());
  const c = new C.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  return (scene.pickPositionSupported && scene.pickPosition(c)) || camera.pickEllipsoid(c) || targetWC();
}
function keyPan(dt) {
  if (LIVESTATE.flying) { camera.cancelFlight(); LIVESTATE.flying = false; }
  let fx = 0, fy = 0; for (const k of LIVESTATE.pan) { fx += PAN_KEYS[k][0]; fy += PAN_KEYS[k][1]; }
  if (!fx && !fy) return;
  const n = Math.hypot(fx, fy); fx /= n; fy /= n;
  const pivot = panPivot(); const enu = C.Transforms.eastNorthUpToFixedFrame(pivot);
  const toLocal = C.Matrix4.inverseTransformation(enu, new C.Matrix4());
  const rel = C.Matrix4.multiplyByPoint(toLocal, camera.positionWC, new C.Cartesian3());   // camera in the pivot's ENU frame
  const range = C.Cartesian3.magnitude(rel); if (!(range > 1)) return;
  const heading = Math.atan2(-rel.x, -rel.y);                                              // direction the camera looks
  const pitch = Math.asin(Math.max(-1, Math.min(1, -rel.z / range)));
  const step = Math.min(range, 30000) * 0.55 * dt;
  const dE = (fy * Math.sin(heading) + fx * Math.cos(heading)) * step, dN = (fy * Math.cos(heading) - fx * Math.sin(heading)) * step;
  const next = C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(dE, dN, 0), new C.Cartesian3());
  camera.lookAt(next, new C.HeadingPitchRange(heading, pitch, range));
}
function guardCamera() {
  if (LIVESTATE.flying || LIVESTATE.tour || C.Matrix4.equals(camera.transform, C.Matrix4.IDENTITY)) return;
  const p = camera.position; if (p.z < MIN_UP) camera.lookAt(C.Matrix4.getTranslation(camera.transform, new C.Cartesian3()), new C.Cartesian3(p.x, p.y, MIN_UP));
}

/* adaptive quality: raymarch steps first, then render resolution, with hysteresis */
function setQuality(steps, scale) {
  LIVESTATE.steps = steps; LIVESTATE.scale = scale; stage.uniforms.u_steps = steps;
  if (Math.abs(viewer.resolutionScale - scale) > 1e-3) viewer.resolutionScale = scale;
}
function adapt(dt, now) {
  /* Frames are slow while tiles stream in after load or a fly-to. Adapting on those made the
     resolution visibly step down and back up right after the map appeared. So frame time is
     only measured on settled frames (tiles loaded, not flying), adaptation waits for a warm-up,
     and resolution drops only after sustained slowness, in small steps, never below 75%. */
  const settled = tilesLoaded() && !LIVESTATE.flying;
  if (dt > 0 && settled) LIVESTATE.ema += (dt - LIVESTATE.ema) * 0.08;
  LIVESTATE.frames++; if (now - LIVESTATE.fpsT0 > 1000) { LIVESTATE.fps = LIVESTATE.frames * 1000 / (now - LIVESTATE.fpsT0); LIVESTATE.frames = 0; LIVESTATE.fpsT0 = now; }
  if (LIVESTATE.quality !== 'auto' || now - LIVESTATE.liveSince < 8000) { LIVESTATE.lastAdapt = now; return; }
  if (!settled) return;
  if (now - LIVESTATE.lastAdapt < 1500) return;
  LIVESTATE.lastAdapt = now; const ms = LIVESTATE.ema * 1000;
  if (ms > 30) {
    LIVESTATE.goodRuns = 0; LIVESTATE.badRuns++;
    if (LIVESTATE.steps > 32) setQuality(LIVESTATE.steps - 8, LIVESTATE.scale);
    else if (LIVESTATE.badRuns >= 3 && LIVESTATE.scale > 0.75) { LIVESTATE.badRuns = 0; setQuality(LIVESTATE.steps, +(LIVESTATE.scale - 0.125).toFixed(3)); }
  } else if (ms < 19) {
    LIVESTATE.badRuns = 0;
    if (++LIVESTATE.goodRuns >= 3) { LIVESTATE.goodRuns = 0;
      if (LIVESTATE.scale < 1) setQuality(LIVESTATE.steps, Math.min(1, +(LIVESTATE.scale + 0.125).toFixed(3)));
      else if (LIVESTATE.steps < 72) setQuality(LIVESTATE.steps + 8, LIVESTATE.scale); }
  } else { LIVESTATE.goodRuns = 0; LIVESTATE.badRuns = 0; }
}

function liveTick() {
  const now = performance.now(); const dt = LIVESTATE.last == null ? 0 : Math.min(LIVESTATE.tour ? 0.25 : 0.1, (now - LIVESTATE.last) / 1000); LIVESTATE.last = now;
  adapt(dt, now);
  if (Q.get('stats')) { $('debug').style.display = 'block'; $('debug').textContent = `${LIVESTATE.fps.toFixed(0)} fps  ${(LIVESTATE.ema * 1000).toFixed(1)} ms  steps ${LIVESTATE.steps}  scale ${LIVESTATE.scale}  tiles ${tilesLoaded() ? 'loaded' : 'loading'}`; }
  if (LIVESTATE.tour) {
    if (!LIVESTATE.tourPaused && !LIVESTATE.seeking) LIVESTATE.tourT += dt * LIVESTATE.speed;
    if (LIVESTATE.tourT >= T.total) { stopTour(); return; }
    applyTime(LIVESTATE.tourT); updateTourBar(); return;
  }
  LIVESTATE.age += dt * LIVESTATE.speed;
  if (LIVESTATE.motion) LIVESTATE.simT += dt * LIVESTATE.speed;
  const age = LIVESTATE.age;
  stage.uniforms.u_fade = ease(age / 0.9);
  stage.uniforms.u_front = 400 + Math.min(1, age / 3.2) * (S.dmax * 1.3 + 2500);
  stage.uniforms.u_time = LIVESTATE.simT;
  if (cur && cur.q != null) $('cNum').textContent = (cur.q * ease((age - 0.2) / 1.6) / 1000).toFixed(1);
  setRingAlpha(LIVESTATE.motion ? 0.55 + 0.35 * Math.sin(LIVESTATE.simT * 2.6) : 0.75);
  if (LIVESTATE.orbit && !LIVESTATE.flying && !C.Matrix4.equals(camera.transform, C.Matrix4.IDENTITY)) camera.rotateRight(-0.045 * dt);
  if (LIVESTATE.pan.size && !LIVESTATE.busy) keyPan(dt);
  guardCamera();
  updateCameraUniforms(viewer.clock.currentTime);
}

/* tour with a scrubber */
function updateTourBar() {
  if (!LIVESTATE.seeking) $('tourSeek').value = LIVESTATE.tourT;
  $('tourTime').textContent = `${fmtClock(LIVESTATE.tourT)} / ${fmtClock(T.total)} · ${chapterAt(LIVESTATE.tourT)}`;
  $('tourPlay').textContent = LIVESTATE.tourPaused ? '▶' : '❚❚'; $('tourPlay').setAttribute('aria-label', LIVESTATE.tourPaused ? 'Play' : 'Pause');
}
async function startTour() {
  if (LIVESTATE.busy) return;
  for (const site of ['silivri', 'sile']) await ensureTerrain(site);
  camera.cancelFlight(); LIVESTATE.flying = false;
  LIVESTATE.tour = true; LIVESTATE.tourT = 0; LIVESTATE.tourPaused = false;
  S.poseSilEnd = S.poseSileStart = S.poseSileEnd = null;
  camera.lookAtTransform(C.Matrix4.IDENTITY); scene.screenSpaceCameraController.enableInputs = false;
  document.documentElement.classList.add('touring'); updateTourBar(); $('tourPlay').focus();
}
function stopTour() {
  LIVESTATE.tour = false; scene.screenSpaceCameraController.enableInputs = true;
  document.documentElement.classList.remove('touring');
  setHud({ brand: 1, tag: 1, title: 0, card: 1, outro: 0, num: 1 });
  selectOverpass(cur, true); $('tourBtn').focus();
}
function togglePause() { LIVESTATE.tourPaused = !LIVESTATE.tourPaused; updateTourBar(); }
function togglePanel(force) {
  const collapsed = force != null ? force : !$('panel').classList.contains('collapsed');
  $('panel').classList.toggle('collapsed', collapsed); $('panelToggle').setAttribute('aria-expanded', String(!collapsed));
  $('panelToggle').setAttribute('aria-label', collapsed ? 'Show panel' : 'Hide panel');
}

function startLive() {
  hideLoading();
  LIVESTATE.liveSince = performance.now();
  setHud({ brand: 1, tag: 1, title: 0, card: 1, outro: 0, num: 1 });
  const want = Q.get('site') && Q.get('ov') ? sceneAt(Q.get('site'), Q.get('ov')) : null;
  const lk = lookIndex(Q.get('look') || LOOK); stage.uniforms.u_look = lk; $('lookSel').value = String(lk);
  selectOverpass(want || cur, false); flyToSite(cur.site, 1.6);   // short glide from the overhead loading view into the orbit
  $('baseBtn').textContent = useGoogle ? 'Open map (no key)' : 'Google 3D Tiles';
  $('keyBtn').hidden = !useGoogle;
  if (matchMedia('(max-width: 760px)').matches) togglePanel(true);
  scene.preUpdate.addEventListener(liveTick);
  const stopOrbit = () => { if (!LIVESTATE.tour && LIVESTATE.orbit) { LIVESTATE.orbit = false; buildPanel(); } };
  scene.canvas.addEventListener('pointerdown', stopOrbit); scene.canvas.addEventListener('wheel', stopOrbit, { passive: true });
  document.querySelectorAll('[data-site]').forEach(b => b.onclick = () => { if (S.site !== b.dataset.site) selectOverpass(peakOf(b.dataset.site), true); });
  $('orbitBtn').onclick = () => { LIVESTATE.orbit = !LIVESTATE.orbit; if (LIVESTATE.orbit) flyToSite(S.site, 1.5); buildPanel(); };
  $('motionBtn').onclick = () => { LIVESTATE.motion = !LIVESTATE.motion; buildPanel(); };
  $('replayBtn').onclick = () => { LIVESTATE.age = 0; };
  $('tourBtn').onclick = startTour;
  $('tourPlay').onclick = togglePause; $('tourExit').onclick = stopTour;
  const seek = $('tourSeek'); seek.max = String(T.total);
  seek.addEventListener('pointerdown', () => { LIVESTATE.seeking = true; });
  window.addEventListener('pointerup', () => { LIVESTATE.seeking = false; });
  seek.oninput = () => { LIVESTATE.tourT = +seek.value; };
  $('lookSel').onchange = e => { stage.uniforms.u_look = +e.target.value; syncURL(); };
  $('gain').oninput = e => { GAIN_MUL = +e.target.value; stage.uniforms.u_gain = baseGain(cur) * GAIN_MUL; $('gainOut').textContent = GAIN_MUL.toFixed(1) + '×'; };
  $('vex').oninput = e => { $('vexOut').textContent = (+e.target.value).toFixed(1) + '×'; stage.uniforms.u_vex = +e.target.value; };
  $('vex').onchange = () => { const age = LIVESTATE.age; applyOverpass(cur); LIVESTATE.age = age; };
  $('speed').oninput = e => { LIVESTATE.speed = +e.target.value; $('speedOut').textContent = (LIVESTATE.speed < 1 ? LIVESTATE.speed.toFixed(2) : LIVESTATE.speed.toFixed(1)) + '×'; };
  $('qualSel').onchange = e => { LIVESTATE.quality = e.target.value; if (e.target.value === 'high') setQuality(72, 1); else if (e.target.value === 'low') setQuality(28, 0.75); else { setQuality(STEPS, 1); LIVESTATE.goodRuns = 0; } };
  $('panelToggle').onclick = () => togglePanel();
  $('shareBtn').onclick = async () => { const url = shareURL(); try { await navigator.clipboard.writeText(url); toast('Link copied. It opens this site and overpass.'); } catch (e) { prompt('Copy this link', url); } };
  $('keyBtn').onclick = () => { try { localStorage.removeItem('gmaps_key'); } catch (e) {} location.href = location.origin + location.pathname; };
  $('baseBtn').onclick = () => {
    const u = new URL(shareURL());
    if (useGoogle) { u.searchParams.set('base', 'open'); location.href = u.toString(); }
    else if (KEY) location.href = u.toString();          // a key is stored but the open map was forced: just switch
    else showKeyGate('');
  };
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
    if (e.key === ' ') { if (tag === 'BUTTON') return; e.preventDefault(); LIVESTATE.tour ? togglePause() : startTour(); return; }
    if (e.key === 'Escape' && LIVESTATE.tour) { stopTour(); return; }
    if (LIVESTATE.tour) return;
    if (e.key === 'o') $('orbitBtn').click();
    else if (e.key === 'r') $('replayBtn').click();
    else if (e.key === 'h') togglePanel();
    else if (e.key === '[' || e.key === ']') { const sp = $('speed'); sp.value = String(Math.max(0.25, Math.min(4, +sp.value * (e.key === ']' ? 1.25 : 0.8)))); sp.dispatchEvent(new Event('input')); toast(`Speed ${$('speedOut').textContent}`, 900); }
    else if (e.key === '1' || e.key === '2') { const site = e.key === '1' ? 'silivri' : 'sile'; if (S.site !== site) selectOverpass(peakOf(site), true); }
    else if (e.key === 'j') stepOverpass(1);
    else if (e.key === 'k') stepOverpass(-1);
    else if (e.key === 'c') { LIVESTATE.pan.clear(); flyToSite(S.site, 1.4); }
    else if (PAN_KEYS[e.key]) { e.preventDefault(); LIVESTATE.pan.add(e.key); stopOrbit(); }
  });
  document.addEventListener('keyup', e => { LIVESTATE.pan.delete(e.key); });
  window.addEventListener('blur', () => LIVESTATE.pan.clear());
  document.addEventListener('visibilitychange', () => { viewer.useDefaultRenderLoop = !document.hidden; LIVESTATE.last = null; });
}
if (LIVE) {
  $('keyForm').onsubmit = e => { e.preventDefault(); const k = $('keyInput').value.trim(); if (!/^[A-Za-z0-9_\-]{20,}$/.test(k)) { $('keyErr').textContent = 'That does not look like a Google API key.'; $('keyErr').hidden = false; return; } try { localStorage.setItem('gmaps_key', k); } catch (err) {} const u = new URL(location.href); u.searchParams.delete('nokey'); u.searchParams.delete('base'); location.href = u.toString(); };
  $('keySkip').onclick = () => {
    if (LIVESTATE.liveSince) { $('keyGate').style.display = 'none'; return; }   // opened from the panel: keep exploring
    const u = new URL(location.href); u.searchParams.set('base', 'open'); location.href = u.toString();
  };
}
