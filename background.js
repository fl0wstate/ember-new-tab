(() => {
  'use strict';

  // Independently written shader: simplex noise + an ordered Bayer threshold.
  // No assets, dependencies, browser permissions, storage, or network access here.
  //
  // Nothing here runs before the page has shown once: the field is on screen
  // and taking keys while the context is made and the shader compiled. An
  // image that arrives in the meantime waits in `pending`.
  const canvas = document.getElementById('background');
  const root = document.documentElement;
  let pending;          // The last backgroundchange not yet applied.
  let apply = null;     // Set once the shader can take one, or can't.

  document.addEventListener('backgroundchange', event => {
    if (apply) apply(event.detail); else pending = event.detail ?? null;
  });

  // Keep the CSS fallback; an image is then shown as a plain picture.
  function unavailable() {
    canvas.style.visibility = 'hidden';
    apply = detail => {
      detail?.source?.close?.();
      if (detail?.source) document.dispatchEvent(new CustomEvent('backgrounderror', { detail: { reason: 'unavailable' } }));
    };
    if (pending !== undefined) apply(pending);
    pending = undefined;
  }

  const vertexSource = `#version 300 es
    in vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
  `;
  const fragmentSource = `#version 300 es
    precision highp float;
    uniform vec2 resolution;
    uniform float time;
    uniform sampler2D imageTexture;
    uniform vec2 imageSize;
    uniform bool hasImage;
    uniform float light; // 0 in the dark appearance, 1 in the light one.
    out vec4 outputColor;

    vec2 gradient(vec2 cell) {
      float angle = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453) * 6.2831853;
      return vec2(cos(angle), sin(angle));
    }

    float simplex(vec2 point) {
      const float skew = 0.3660254038;
      const float unskew = 0.2113248654;
      vec2 cell = floor(point + (point.x + point.y) * skew);
      vec2 a = point - cell + (cell.x + cell.y) * unskew;
      vec2 stepCell = a.x > a.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec2 b = a - stepCell + unskew;
      vec2 c = a - 1.0 + 2.0 * unskew;
      vec3 weight = max(vec3(0.5) - vec3(dot(a,a), dot(b,b), dot(c,c)), 0.0);
      weight *= weight;
      weight *= weight;
      return 70.0 * dot(weight, vec3(
        dot(gradient(cell), a),
        dot(gradient(cell + stepCell), b),
        dot(gradient(cell + 1.0), c)
      ));
    }

    float field(vec2 point) {
      return simplex(point) * 0.65 + simplex(point * 2.03 + 7.1) * 0.25
        + simplex(point * 4.01 - 3.7) * 0.1;
    }

    float bayer8(ivec2 pixel) {
      int value = 0;
      for (int bit = 0; bit < 3; bit++) {
        int x = (pixel.x >> bit) & 1;
        int y = (pixel.y >> bit) & 1;
        value += (((x ^ y) * 2 + y) << (2 * (2 - bit)));
      }
      return (float(value) + 0.5) / 64.0;
    }

    vec3 palette(float level) {
      vec3 dark = vec3(0.025, 0.012, 0.006);
      vec3 rust = vec3(0.45, 0.12, 0.025);
      vec3 orange = vec3(1.0, 0.32, 0.075);
      vec3 light = vec3(1.0, 0.77, 0.43);
      if (level < 0.42) return mix(dark, rust, level / 0.42);
      if (level < 0.83) return mix(rust, orange, (level - 0.42) / 0.41);
      return mix(orange, light, (level - 0.83) / 0.17);
    }

    // The same embers on paper: the quiet parts are cream, the plume is ink.
    const vec3 paper = vec3(0.83, 0.8, 0.75);
    vec3 dayPalette(float level) {
      vec3 apricot = vec3(0.9, 0.68, 0.48);
      vec3 orange = vec3(0.88, 0.42, 0.13);
      vec3 rust = vec3(0.6, 0.2, 0.05);
      if (level < 0.42) return mix(paper, apricot, level / 0.42);
      if (level < 0.83) return mix(apricot, orange, (level - 0.42) / 0.41);
      return mix(orange, rust, (level - 0.83) / 0.17);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / resolution;
      vec2 point = (gl_FragCoord.xy - resolution * 0.5) / resolution.y;
      float drift = time * 0.025;
      vec2 warp = vec2(field(point * 1.05 + vec2(drift, 2.4)),
                       field(point * 1.05 + vec2(5.2, -drift)));
      float cloud = field(point * 2.0 + warp * 0.7 + vec2(drift * 0.4, 1.3));
      // Bright lower-right ember plume; leave the upper/central area quiet.
      float plume = exp(-dot((uv - vec2(1.08, -0.10)) * vec2(1.1, 0.85),
                             (uv - vec2(1.08, -0.10)) * vec2(1.1, 0.85)) * 2.7);
      float ribbon = 0.5 + 0.5 * sin(point.x * 2.0 - point.y * 2.5 + cloud * 3.5);
      float brightness = clamp(plume * 0.94 + cloud * 0.27 + ribbon * 0.10 - 0.09, 0.0, 1.0);
      float threshold = bayer8(ivec2(gl_FragCoord.xy));
      float quantized = floor(brightness * 7.0 + threshold) / 7.0;
      // Binary fabric over the tonal field, not random grain or a blurred photo.
      float ink = step(threshold, clamp(brightness * 1.22 + cloud * 0.18, 0.0, 1.0));
      vec3 color = mix(palette(quantized) * mix(0.12, 1.0, ink),
                       mix(paper, dayPalette(quantized), mix(0.3, 1.0, ink)), light);
      if (hasImage) {
        // Cover-fit the uploaded texture without stretching, then move it
        // gently through the same noise field that animates the default.
        float viewAspect = resolution.x / resolution.y;
        float sourceAspect = imageSize.x / imageSize.y;
        vec2 crop = vec2(min(1.0, viewAspect / sourceAspect),
                         min(1.0, sourceAspect / viewAspect));
        vec2 imageUV = (uv - 0.5) * crop + 0.5;
        imageUV += warp * 0.018 * crop;
        vec4 sampleColor = texture(imageTexture, clamp(imageUV, 0.0, 1.0));
        vec3 source = sampleColor.rgb * sampleColor.a;
        float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));
        float movingLight = clamp(0.76 + cloud * 0.42 + ribbon * 0.13, 0.25, 1.12);
        float level = clamp(luminance * movingLight, 0.0, 1.0);
        float quantizedLight = floor(level * 7.0 + threshold) / 7.0;
        vec3 chroma = source / max(luminance, 0.04);
        float fabric = step(threshold, clamp(0.5 + cloud * 0.6 + level * 0.42, 0.0, 1.0));
        vec3 lit = clamp(chroma * quantizedLight, 0.0, 1.0);
        // By day the weave lets paper through where by night it lets the dark,
        // and the whole picture is lifted a little.
        color = mix(lit * mix(0.22, 1.0, fabric),
                    mix(mix(paper, lit, 0.72), lit * 0.94, fabric), light);
      }
      float centerShade = 1.0 - 0.38 * exp(-dot(point - vec2(-0.12, 0.18),
                                                    point - vec2(-0.12, 0.18)) * 3.0);
      outputColor = vec4(mix(color * centerShade, mix(paper, color, mix(1.0, centerShade, 0.5)), light), 1.0);
    }
  `;


  // The second pass: the embers, drawn small, are put on screen at the
  // window's own size, and where the field and its rows lie they are seen
  // through glass. The lens is liquidGL's (MIT, © NaughtyDuk,
  // liquidgl.naughtyduk.com): its rounded box, corner normals, refraction
  // with a bevel, frost and moving highlights. liquidGL itself reads a
  // picture of the page; here the page behind the glass is this shader, so
  // the lens reads it directly and follows every frame at no extra cost.
  const glassSource = `#version 300 es
    precision highp float;
    uniform sampler2D scene;
    uniform vec2 resolution;
    uniform vec4 lens[2];       // Centre and half size, in pixels.
    uniform vec3 lensStyle[2];  // Corner radius, frost in pixels, tint.
    uniform int lensCount;
    uniform float light;
    uniform float time;
    out vec4 outputColor;

    const float REFRACTION = 0.014;
    const float BEVEL_DEPTH = 0.052;
    const float BEVEL_WIDTH = 0.2;

    float roundBox(vec2 p, vec2 b, float r) {
      return length(max(abs(p) - b + r, 0.0)) - r;
    }

    vec2 cornerNormal(vec2 p, vec2 b, float r, vec2 fallback) {
      vec2 q = abs(p) - b + r;
      vec2 m = max(q, 0.0);
      float l = length(m);
      if (l <= 0.0) return fallback;
      float w = smoothstep(0.0, max(r * 0.5, 1.0), min(m.x, m.y));
      if (w <= 0.0) return fallback;
      vec2 s = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
      return normalize(mix(fallback, s * (m / l), w));
    }

    float random(vec2 st) {
      return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / resolution;
      // Outside the glass each shader pixel stays a crisp square.
      vec3 color = texelFetch(scene, ivec2(uv * vec2(textureSize(scene, 0))), 0).rgb;
      for (int i = 0; i < 2; i++) {
        if (i >= lensCount) break;
        vec2 p = gl_FragCoord.xy - lens[i].xy;
        vec2 b = lens[i].zw;
        float radius = lensStyle[i].x;
        float d = roundBox(p, b, radius);
        float inShape = 1.0 - smoothstep(-0.75, 0.75, d);
        if (inShape <= 0.0) continue;

        vec2 box = b * 2.0;
        float edge = 1.0 - smoothstep(0.0, BEVEL_WIDTH * min(box.x, box.y), -d);
        float amount = edge * REFRACTION + pow(edge, 10.0) * BEVEL_DEPTH;
        vec2 q = p / box.y;
        float centreBlend = smoothstep(0.15, 0.45, length(q));
        vec2 direction = cornerNormal(p, b, radius, normalize(q + vec2(0.000001)));
        vec2 offset = direction * amount * centreBlend;
        offset.x *= resolution.y / resolution.x; // The same bend in pixels both ways.
        vec2 at = uv + offset;

        vec3 seen = vec3(0.0);
        float frost = lensStyle[i].y;
        const int SAMPLES = 16;
        for (int n = 0; n < SAMPLES; n++) {
          float angle = random(uv + float(n)) * 6.283185;
          float reach = sqrt(random(uv - float(n))) * frost;
          seen += texture(scene, at + vec2(cos(angle), sin(angle)) * reach / resolution).rgb;
        }
        seen /= float(SAMPLES);

        // Smoked by night, milky by day, so what is written on it reads.
        seen = mix(seen, mix(vec3(0.07, 0.065, 0.06), vec3(0.94, 0.92, 0.89), light), lensStyle[i].z);

        vec2 across = (p + b) / box;
        vec2 lamp1 = vec2(sin(time * 0.2), cos(time * 0.3)) * 0.6 + 0.5;
        vec2 lamp2 = vec2(sin(time * -0.4 + 1.5), cos(time * 0.25 - 0.5)) * 0.6 + 0.5;
        float shine = smoothstep(0.4, 0.0, distance(across, lamp1)) * 0.1
                    + smoothstep(0.5, 0.0, distance(across, lamp2)) * 0.08;
        // The rim catches the light from above and a little from below.
        float rim = smoothstep(1.6, 0.0, abs(d + 1.0)) * mix(0.1, 0.42, smoothstep(-0.6, 1.0, direction.y))
                  + pow(edge, 6.0) * 0.07;
        seen += (shine + rim) * mix(1.0, 0.75, light);

        color = mix(color, seen, inShape);
      }
      outputColor = vec4(color, 1.0);
    }
  `;

  function start() {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'low-power',
    });
    if (!gl) { unavailable(); return; }

    const shader = (type, source) => {
      const made = gl.createShader(type);
      gl.shaderSource(made, source);
      gl.compileShader(made);
      return made;
    };
    const vertex = shader(gl.VERTEX_SHADER, vertexSource);
    const build = source => {
      const fragment = shader(gl.FRAGMENT_SHADER, source);
      const made = gl.createProgram();
      gl.attachShader(made, vertex);
      gl.attachShader(made, fragment);
      gl.bindAttribLocation(made, 0, 'position');
      gl.linkProgram(made);
      return { program: made, fragment };
    };
    const built = [build(fragmentSource), build(glassSource)];
    const program = built[0].program;

    const linked = () => {
      if (gl.isContextLost()) { unavailable(); return; }
      for (const { program: made, fragment } of built) {
        if (gl.getProgramParameter(made, gl.LINK_STATUS)) { gl.deleteShader(fragment); continue; }
        console.warn('Animated background unavailable:',
          gl.getProgramInfoLog(made) || gl.getShaderInfoLog(fragment) || gl.getShaderInfoLog(vertex));
        unavailable();
        return;
      }
      gl.deleteShader(vertex);
      run(gl, program, built[1].program);
    };
    // Asking for the link status would hold the page until the compile is
    // done. Where the driver compiles on another thread, wait for it there.
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    if (!parallel) { linked(); return; }
    const wait = () => {
      if (gl.isContextLost() || built.every(b => gl.getProgramParameter(b.program, parallel.COMPLETION_STATUS_KHR))) linked();
      else setTimeout(wait, 4);
    };
    wait();
  }

  function run(gl, program, glass) {
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const resolution = gl.getUniformLocation(program, 'resolution');
    const time = gl.getUniformLocation(program, 'time');
    const hasImage = gl.getUniformLocation(program, 'hasImage');
    const imageSize = gl.getUniformLocation(program, 'imageSize');
    const light = gl.getUniformLocation(program, 'light');
    gl.uniform1i(gl.getUniformLocation(program, 'imageTexture'), 0);
    gl.uniform2f(imageSize, 1, 1);

    // The embers are drawn into this, a third of the window's size.
    const scene = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, scene);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const sceneBuffer = gl.createFramebuffer();
    let sceneWidth = 0;
    let sceneHeight = 0;
    gl.useProgram(glass);
    const glassUniform = name => gl.getUniformLocation(glass, name);
    const glassResolution = glassUniform('resolution');
    const glassLens = glassUniform('lens');
    const glassStyle = glassUniform('lensStyle');
    const glassCount = glassUniform('lensCount');
    const glassLight = glassUniform('light');
    const glassTime = glassUniform('time');
    gl.uniform1i(glassUniform('scene'), 1);
    gl.useProgram(program);

    // What lies under glass: the field, and its rows while they show.
    const panes = [
      { element: document.getElementById('query'), frost: 5, tint: 0.3 },
      { element: document.getElementById('suggestions'), frost: 13, tint: 0.58 },
    ];
    const lensData = new Float32Array(8);
    const styleData = new Float32Array(6);
    let lensCount = 0;
    function measure() {
      const scale = canvas.width / innerWidth;
      lensCount = 0;
      for (const pane of panes) {
        const box = pane.element.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) continue;
        lensData.set([(box.left + box.width / 2) * scale, canvas.height - (box.top + box.height / 2) * scale,
          box.width / 2 * scale, box.height / 2 * scale], lensCount * 4);
        const radius = Math.min(parseFloat(getComputedStyle(pane.element).borderTopLeftRadius) || 0, box.height / 2);
        styleData.set([radius * scale, pane.frost * scale, pane.tint], lensCount * 3);
        lensCount++;
      }
    }
    const appearance = matchMedia('(prefers-color-scheme: light)');

    function createTexture() {
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    }
    const blank = () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    let texture = createTexture();
    blank();
    gl.uniform1i(hasImage, 0);

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    // Twenty frames a second: the embers drift slowly, and each frame costs the
    // page, the GPU process and the browser a little each. On a timer, since
    // the browser's own frame callback comes thirty times a second here and
    // could only give fifteen.
    const frameInterval = 1000 / 20;
    let request = null;
    let elapsed = 0;
    let previous = null;
    let lost = false;
    let shown = false;   // Nothing is drawn until the first picture is known.
    let resizing = false;

    function resize() {
      // About three CSS pixels per shader pixel, capped on very large displays.
      const scale = Math.min(1 / 3, 960 / innerWidth, 600 / innerHeight);
      const width = Math.max(1, Math.round(innerWidth * scale));
      const height = Math.max(1, Math.round(innerHeight * scale));
      if (sceneWidth !== width || sceneHeight !== height) {
        sceneWidth = width;
        sceneHeight = height;
        gl.activeTexture(gl.TEXTURE1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, sceneBuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scene, 0);
        gl.activeTexture(gl.TEXTURE0);
      }
      // One canvas pixel per CSS pixel. At a Retina screen's own sharpness the
      // glass pass filled four times the pixels each frame for an edge only
      // slightly crisper; measured, that was most of the GPU's work.
      const sharp = 1;
      const fullWidth = Math.max(1, Math.round(innerWidth * sharp));
      const fullHeight = Math.max(1, Math.round(innerHeight * sharp));
      if (canvas.width !== fullWidth || canvas.height !== fullHeight) {
        canvas.width = fullWidth;
        canvas.height = fullHeight;
      }
      gl.uniform2f(resolution, width, height);
      measure();
    }

    function draw() {
      const seconds = 40 + elapsed / 1000;
      const day = appearance.matches ? 1 : 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneBuffer);
      gl.viewport(0, 0, sceneWidth, sceneHeight);
      gl.uniform1f(time, seconds);
      gl.uniform1f(light, day);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(glass);
      gl.uniform2f(glassResolution, canvas.width, canvas.height);
      gl.uniform4fv(glassLens, lensData);
      gl.uniform3fv(glassStyle, styleData);
      gl.uniform1i(glassCount, lensCount);
      gl.uniform1f(glassLight, day);
      gl.uniform1f(glassTime, seconds);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.useProgram(program);
    }

    function tick() {
      request = null;
      if (lost || document.hidden || reducedMotion.matches) return;
      const now = performance.now();
      if (previous !== null) elapsed += Math.min(now - previous, 100);
      previous = now;
      draw();
      request = setTimeout(tick, Math.max(0, frameInterval - (performance.now() - now)));
    }

    function sync() {
      if (request !== null) clearTimeout(request);
      request = null;
      previous = null;
      if (lost || !shown || document.hidden) return;
      draw();
      if (!reducedMotion.matches) { previous = performance.now(); request = setTimeout(tick, frameInterval); }
    }

    function show() {
      if (shown || lost) return;
      shown = true;
      resize();
      canvas.classList.add('drawn');
      root.dataset.glass = 'on'; // The field gives up its CSS glass for this one.
      sync();
    }

    // Drawn again at once, between frames too: rows come and go as fast as keys.
    function relens() {
      if (lost || !shown) return;
      measure();
      if (!document.hidden) draw();
    }
    const watcher = new ResizeObserver(relens);
    for (const pane of panes) watcher.observe(pane.element);
    appearance.addEventListener('change', () => { if (shown && !lost && !document.hidden) draw(); });

    function setImage(detail) {
      if (lost) { detail?.source?.close?.(); return; }
      const source = detail?.source;
      let replacement = null;
      try {
        replacement = createTexture();
        if (source) {
          // A bitmap comes already turned over; the unpack flag doesn't reach it.
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !detail.flipped);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          // The picture is drawn far smaller than it is: without the smaller
          // copies its fine detail would shimmer as the noise moves it.
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.uniform2f(imageSize, detail.width, detail.height);
        } else {
          blank();
        }
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Texture upload failed.');
        gl.deleteTexture(texture);
        texture = replacement;
        gl.uniform1i(hasImage, source ? 1 : 0);
        canvas.style.visibility = 'visible';
        if (shown) { root.dataset.glass = 'on'; sync(); } else show();
      } catch {
        if (replacement) gl.deleteTexture(replacement);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        canvas.style.visibility = 'hidden';
        delete root.dataset.glass;
        document.dispatchEvent(new CustomEvent('backgrounderror', { detail: { reason: 'failed' } }));
      } finally {
        source?.close?.();
      }
    }

    addEventListener('resize', () => {
      if (lost || !shown || resizing) return;
      resizing = true;
      requestAnimationFrame(() => { resizing = false; if (!lost) { resize(); sync(); } });
    });
    document.addEventListener('visibilitychange', sync);
    reducedMotion.addEventListener('change', sync);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      lost = true;
      canvas.style.visibility = 'hidden';
      delete root.dataset.glass;
      sync();
    });
    // A fresh page rebuilds the shader; don't loop on a failing graphics context.

    apply = setImage;
    const waited = pending;
    pending = undefined;
    if (waited !== undefined) setImage(waited);
    else if (root.dataset.background !== 'image') show();
    // A saved picture is on its way: draw it first, not the embers. If it
    // never comes, the embers after all.
    else setTimeout(show, 1500);
  }

  // After the first frame is on screen. A tab opened behind another one has
  // no frames, and starts when it is looked at.
  requestAnimationFrame(() => setTimeout(start, 0));
})();
