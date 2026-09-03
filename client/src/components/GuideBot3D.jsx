import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

// The guide mascot, as a real 3D model. Replaces the flat SVG stand-in that
// itself replaced the two-PNG robot testers called "scary" (DOT-05).
//
// The model ships from `public/`, NOT `src/`, on purpose: at ~950KB it must
// stay out of the JS bundle and be fetched only when the tour actually opens.
// GuideBot.jsx lazy-loads this whole module for the same reason — nobody who
// skips the tour should pay for three.js.
//
// Theming: white body, black linework, one blue. The model arrives untextured,
// so the whole look is built here rather than baked in. It was reported as
// reading "completely grey" — a white body under a neutral key with no hue
// anywhere has nothing for the eye to catch, and every surface resolves to the
// same value. The blue is the fix and is used three ways, all of them small:
// a cool rim light down one side, a blue fill in the shadows, and the visor
// (any mesh the model names as eye/visor/screen/face) lit outright.
//
// BLUE is #2563eb — the same accent as the home screen's live dot and rules,
// so the mascot and the app agree with each other.
const MODEL = '/racktrack-bot.glb';
const ACCENT = '#2563eb';

/* The model is ONE unnamed mesh with ONE material — no eyes, no visor, no
   separable parts, and no UVs either. So the blue cannot be assigned to a
   named node (an earlier attempt matched on /eye|visor|screen/ and silently
   found nothing, which is why the mascot stayed grey), and it cannot be
   textured. It has to be painted from the geometry itself.
   
   This shader injection does that: a horizontal band across the FRONT of the
   head, found by local position and surface normal rather than by name. Every
   fragment above the shoulders whose normal faces the camera inside the band
   takes the accent, and glows slightly. It hugs whatever surface is actually
   there, so it cannot float off the model the way added geometry would.
   
   The numbers are measured, not guessed. The file's bounds are x ±0.462,
   y -0.559..0.560, z ±0.363, and the root node applies a 0.894 scale plus a
   0.5 lift (so the model stands 1.0 tall on the floor, as the framing presets
   assume). Rendering it and measuring the visor plate off the image puts it
   between y -0.08 and +0.375 in LOCAL space, which is what the band spans. */
function paintVisor(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rtAccent = { value: new THREE.Color(ACCENT) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 rtPos;
        varying vec3 rtNrm;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        rtPos = position;
        rtNrm = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 rtPos;
        varying vec3 rtNrm;
        uniform vec3 rtAccent;`)
      // color_fragment runs before emissivemap_fragment in the standard
      // shader, so `rtBand` declared here is still in scope below.
      .replace('#include <color_fragment>', `#include <color_fragment>
        float rtUp    = smoothstep(-0.12, -0.05, rtPos.y) * (1.0 - smoothstep(0.33, 0.40, rtPos.y));
        float rtFront = smoothstep(0.45, 0.80, rtNrm.z);
        float rtBand  = rtUp * rtFront;
        diffuseColor.rgb = mix(diffuseColor.rgb, rtAccent, rtBand * 0.95);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += rtAccent * rtBand * 0.42;`);
  };
  // Two materials with identical parameters but different onBeforeCompile need
  // different cache keys, or three reuses the first one's compiled program.
  material.customProgramCacheKey = () => 'rt-visor-v1';
  return material;
}

// Framing presets. The model is exactly 1.0 unit tall with its origin on the
// floor, so these are expressed in model units and stay correct regardless of
// the pixel size of the box we are rendered into.
const FRAMING = {
  // Whole body, with a little air above the head so the crown never touches
  // the edge of the card it sits on.
  full: { distance: 2.35, height: 0.52, target: 0.50, fov: 30 },
  // Head and shoulders. Chosen against the real 62px box in TourOverlay: any
  // closer and the head clips the sides, any further and the face stops being
  // readable at that size. Retuned for this model, which is far more
  // head-heavy than the one it replaced.
  bust: { distance: 2.10, height: 0.02, target: 0.66, fov: 26 },
};

function Bot({ framing, reduced }) {
  const { scene } = useGLTF(MODEL);
  const group = useRef();

  // The framing offset: slides the part of the model we want to frame onto the
  // origin, which is where the camera is pointed. Everything animated below is
  // expressed relative to this, never assigned over the top of it.
  const baseY = -(FRAMING[framing] || FRAMING.full).target;

  // useGLTF caches by URL, so the same object graph comes back for every
  // mount. Two mascots on screen at once (intro modal closing while the
  // overlay opens) would otherwise fight over one transform.
  const model = useMemo(() => {
    const copy = scene.clone(true);
    copy.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      // The .obj arrived with no material of its own, so the whole mesh took a
      // single flat mid-grey and read washed out. The app is white surfaces
      // with black accents, so the body is near-white and the accents come
      // from the outline shell below plus tighter lighting, which lets the
      // recessed eyes, mouth and panel lines fall into shadow.
      // A cool white rather than a neutral one — the same #eef3fd the flat SVG
      // stand-in uses, so the two versions of the character agree. The file's
      // own baked material is a mid-grey (0.58, 0.60, 0.64), which is the grey
      // that was being reported; it is replaced outright, not tinted.
      o.material = paintVisor(new THREE.MeshStandardMaterial({
        color: '#eef3fd',
        emissive: new THREE.Color(ACCENT),
        emissiveIntensity: 0,   // the shader adds emission only inside the band
        roughness: 0.42,
        metalness: 0.06,
      }));
    });
    return copy;
  }, [scene]);

  // Black linework, drawn as an inverted hull: the same mesh a little larger
  // with its faces flipped, so only the parts facing away from the camera
  // survive and read as an outline. One extra draw call, no post-processing.
  const outline = useMemo(() => {
    const shell = scene.clone(true);
    shell.traverse((o) => {
      if (!o.isMesh) return;
      o.material = new THREE.MeshBasicMaterial({ color: '#121212', side: THREE.BackSide });
      o.scale.multiplyScalar(1.018);
    });
    return shell;
  }, [scene]);

  // Idle motion: a slow breath-like bob plus a small sway, so it reads as
  // alive without becoming a distraction next to the step it is explaining.
  //
  // The bob is applied RELATIVE to baseY. Assigning `position.y` outright is
  // what made the mascot show only its legs: it overwrote the -baseY framing
  // offset on the first animated frame, dropping the model so its feet sat on
  // the origin the camera is aimed at. Static renders never caught it because
  // nothing here runs until the animation loop does.
  useFrame((state) => {
    if (!group.current || reduced) return;
    const t = state.clock.elapsedTime;
    group.current.position.y = baseY + Math.sin(t * 1.1) * 0.022;
    group.current.rotation.y = Math.sin(t * 0.45) * 0.16;
    group.current.rotation.z = Math.sin(t * 0.9) * 0.012;
  });

  // Reduced motion still gets a three-quarter view rather than a flat
  // head-on one — the pose is what makes it read as a character.
  useEffect(() => {
    if (reduced && group.current) group.current.rotation.y = 0.32;
  }, [reduced]);

  return (
    <group ref={group} position={[0, baseY, 0]}>
      <primitive object={outline} />
      <primitive object={model} />
    </group>
  );
}

export default function GuideBot3D({ framing = 'full', reduced = false }) {
  const f = FRAMING[framing] || FRAMING.full;
  return (
    <Canvas
      // alpha so it sits on whatever card surface it is placed over, and
      // "demand" when motion is reduced so we render once and stop.
      // NoToneMapping matters here. R3F's Canvas defaults to ACES filmic,
      // which compresses highlights — it turned the near-white body into the
      // flat mid-grey testers reported, and flattened the shading that picks
      // out the eyes and seams. The mascot is a flat-shaded UI element, not a
      // photographic scene, so film-style tone mapping is the wrong default.
      gl={{
        antialias: true,
        alpha: true,
        powerPreference: 'low-power',
        toneMapping: THREE.NoToneMapping,
      }}
      dpr={[1, 2]}
      frameloop={reduced ? 'demand' : 'always'}
      camera={{ position: [0, f.height, f.distance], fov: f.fov }}
      // `camera` above sets position only, and a fresh camera keeps its
      // identity rotation — it stares straight down -Z rather than at the
      // model. The group is offset so the part we want to frame sits at the
      // origin, so aim the camera there. (This was necessary but not what
      // caused "only the legs show" — see the useFrame note in Bot.)
      onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {/* Deliberately contrasty for a white body: a soft bounce well below
          the key, so the recessed eyes, mouth and panel seams actually fall
          into shadow instead of being flattened out. A brighter ambient made
          the model read as one grey blob.

          The ground half of the hemisphere is blue rather than grey, so what
          bounces up into the shadows carries the accent — that is what stops
          the underside resolving to the same neutral as everything else. The
          rim light behind and to the left is the same blue at full strength:
          it draws a cool edge down one side of a white body, which is the
          whole difference between "white" and "grey". */}
      {/* The previous rig was a 2.6-intensity WHITE key against a 0.55 blue
          fill. At that ratio the blue was arithmetically present and visually
          absent — every lit surface clipped to white and everything else read
          as grey, which is exactly what was reported. The key is down to 1.5,
          the blue fill is up to 1.9 and comes from the camera's left where it
          lands on the body rather than behind it, and a second blue rim picks
          out the silhouette's right edge. White where the light hits, blue in
          everything that is not lit, black on the outline. */}
      {/* White body, blue visor, black outline — in that order of area. The
          blue in the RIG is deliberately restrained: turned up far enough to
          be obvious it washes the whole head and the mascot stops being white,
          which is a different failure from the grey one and no better. It sits
          in the shadow side and the rim, and the visor carries the colour. */}
      <hemisphereLight args={['#ffffff', '#9dbcff', 0.9]} />
      <directionalLight position={[2.5, 4, 3]} intensity={2.0} />
      <directionalLight position={[-2.8, 0.6, 2.0]} intensity={0.55} color={ACCENT} />
      <directionalLight position={[3.0, 1.0, -2.6]} intensity={0.7} color={ACCENT} />
      <Bot framing={framing} reduced={reduced} />
    </Canvas>
  );
}

useGLTF.preload(MODEL);
