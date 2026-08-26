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
// Theming: the app has no colour accent (--accent is #121212, everything else
// is a grey ramp), so the shipped .glb has every texture converted to
// greyscale. The only thing added back is a faint emissive on the two eye
// meshes — without it the eyes read as dead black holes rather than lit.
const MODEL = '/racktrack-bot.glb';

// The eyes, by node name in the source model. Verified against the file:
// both sit at y≈0.769, z≈0.206, mirrored on x — i.e. the two lenses.
const EYES = new Set(['tripo_part_26_Clone', 'tripo_part_38_Clone']);

// Framing presets. The model is exactly 1.0 unit tall with its origin on the
// floor, so these are expressed in model units and stay correct regardless of
// the pixel size of the box we are rendered into.
const FRAMING = {
  full: { distance: 2.15, height: 0.52, target: 0.50, fov: 30 },
  // Head and shoulders. Chosen against the real 62px box in TourOverlay: any
  // closer and the crown clips the top edge, any further and the face stops
  // being readable at that size.
  bust: { distance: 1.30, height: 0.10, target: 0.72, fov: 28 },
};

function Bot({ framing, reduced }) {
  const { scene } = useGLTF(MODEL);
  const group = useRef();

  // useGLTF caches by URL, so the same object graph comes back for every
  // mount. Two mascots on screen at once (intro modal closing while the
  // overlay opens) would otherwise fight over one transform.
  const model = useMemo(() => {
    const copy = scene.clone(true);
    copy.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
      // Clone materials too, else the emissive below leaks into the cached
      // original and every later mount inherits it.
      o.material = o.material.clone();
      if (EYES.has(o.name)) {
        o.material.emissive = new THREE.Color('#8f949c');
        o.material.emissiveIntensity = 0.55;
      }
    });
    return copy;
  }, [scene]);

  // Idle motion: a slow breath-like bob plus a small sway, so it reads as
  // alive without becoming a distraction next to the step it is explaining.
  useFrame((state) => {
    if (!group.current || reduced) return;
    const t = state.clock.elapsedTime;
    group.current.position.y = Math.sin(t * 1.1) * 0.022;
    group.current.rotation.y = Math.sin(t * 0.45) * 0.16;
    group.current.rotation.z = Math.sin(t * 0.9) * 0.012;
  });

  // Reduced motion still gets a three-quarter view rather than a flat
  // head-on one — the pose is what makes it read as a character.
  useEffect(() => {
    if (reduced && group.current) group.current.rotation.y = 0.32;
  }, [reduced]);

  return (
    <group ref={group} position={[0, -FRAMING[framing].target, 0]}>
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
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
      dpr={[1, 2]}
      frameloop={reduced ? 'demand' : 'always'}
      camera={{ position: [0, f.height, f.distance], fov: f.fov }}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {/* Lit for a light UI: a soft sky/ground bounce, one key from the
          front-left to pick out the panel lines, and a dim fill so the
          right side never goes to solid black. */}
      <hemisphereLight args={['#ffffff', '#c8ccd2', 2.1]} />
      <directionalLight position={[2.5, 4, 3]} intensity={1.9} />
      <directionalLight position={[-3, 1.5, -2]} intensity={0.55} />
      <Bot framing={framing} reduced={reduced} />
    </Canvas>
  );
}

useGLTF.preload(MODEL);
