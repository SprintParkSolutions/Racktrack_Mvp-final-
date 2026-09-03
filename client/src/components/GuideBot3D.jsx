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

/* Which meshes are the face. GLB node names come from whoever authored the
   model, so this matches on the words such parts are usually called rather
   than on one exact name; if none match, nothing is lit and the model still
   reads correctly from the rim and fill alone. */
const VISOR_RE = /(eye|visor|screen|face|lens|display)/i;

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
      // The visor is the one part that carries the colour outright: emissive so
      // it holds its blue whatever the lighting does, which is what makes the
      // model read as "looking at you" rather than as a white shape.
      if (VISOR_RE.test(o.name || '')) {
        o.material = new THREE.MeshStandardMaterial({
          color: ACCENT,
          emissive: ACCENT,
          emissiveIntensity: 0.55,
          roughness: 0.28,
          metalness: 0.0,
        });
        return;
      }
      o.material = new THREE.MeshStandardMaterial({
        color: '#f7f8fa',
        roughness: 0.46,
        metalness: 0.04,
      });
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
      <hemisphereLight args={['#ffffff', '#93b4f5', 1.05]} />
      <directionalLight position={[2.5, 4, 3]} intensity={2.6} />
      <directionalLight position={[-3, 1.5, -2]} intensity={0.55} color={ACCENT} />
      <Bot framing={framing} reduced={reduced} />
    </Canvas>
  );
}

useGLTF.preload(MODEL);
