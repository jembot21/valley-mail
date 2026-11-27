/**
 * Valley Mail world obstacles: radio towers, bridges, rock arches, power lines, and windmills.
 * Pure logic and 3D wireframe / shaded rendering for route hazards.
 *
 * Exports:
 *   OBSTACLE_TYPES — specifications for tower, bridge, arch, pylon, and windmill obstacles.
 *   generateRouteObstacles(world, routeType, seed) — places obstacles along river corridor.
 *   checkObstacleCollisions(plane, obstacles) — tests aircraft bounding sphere against hazards.
 *   drawObstacles(ctx, obstacles, projectFn, palette, time) — projects and draws 3D hazards.
 */

export const OBSTACLE_TYPES = Object.freeze({
  radio_mast: {
    type: 'radio_mast',
    name: 'Broadcast Mast',
    height: 72,
    baseWidth: 10,
    hasBeacon: true,
    beaconPeriod: 1.0,
    color: '#d6453d',
    beaconColor: '#ff2a2a',
  },
  suspension_bridge: {
    type: 'suspension_bridge',
    name: 'Canyon Suspension Bridge',
    height: 38,
    spanWidth: 120,
    hasCables: true,
    color: '#8b97a2',
  },
  canyon_arch: {
    type: 'canyon_arch',
    name: 'Sandstone Natural Arch',
    height: 85,
    archSpan: 80,
    archClearance: 45,
    color: '#b56d4b',
  },
  power_pylon: {
    type: 'power_pylon',
    name: 'High-Voltage Pylon',
    height: 52,
    baseWidth: 14,
    hasWires: true,
    color: '#5a626a',
  },
  windmill: {
    type: 'windmill',
    name: 'Valley Windmill',
    height: 28,
    bladeRadius: 14,
    color: '#9e8b70',
  },
});

export function generateRouteObstacles(world, routeType = 'valley', seed = 54321) {
  const obstacles = [];
  const route = world.route;
  const startZ = route.firstRingZ;
  const endZ = route.lastRingZ;
  const length = endZ - startZ;

  // Radio mast on high ridge beside valley
  const mastZ = startZ + length * 0.35;
  const mastX = world.riverCenter(mastZ) + 160;
  obstacles.push({
    id: 'mast-1',
    type: 'radio_mast',
    position: { x: mastX, y: world.groundHeight(mastX, mastZ), z: mastZ },
    height: 72,
    radius: 6,
    bounds: { minX: mastX - 8, maxX: mastX + 8, minZ: mastZ - 8, maxZ: mastZ + 8 },
  });

  // Power transmission pylons crossing river
  const pylonZ = startZ + length * 0.65;
  const pylonWestX = world.riverCenter(pylonZ) - 90;
  const pylonEastX = world.riverCenter(pylonZ) + 90;
  obstacles.push(
    {
      id: 'pylon-w',
      type: 'power_pylon',
      position: { x: pylonWestX, y: world.groundHeight(pylonWestX, pylonZ), z: pylonZ },
      height: 54,
      radius: 8,
      bounds: { minX: pylonWestX - 10, maxX: pylonWestX + 10, minZ: pylonZ - 10, maxZ: pylonZ + 10 },
    },
    {
      id: 'pylon-e',
      type: 'power_pylon',
      position: { x: pylonEastX, y: world.groundHeight(pylonEastX, pylonZ), z: pylonZ },
      height: 54,
      radius: 8,
      bounds: { minX: pylonEastX - 10, maxX: pylonEastX + 10, minZ: pylonZ - 10, maxZ: pylonZ + 10 },
      connectedTo: { x: pylonWestX, z: pylonZ },
    }
  );

  // Canyon arch or suspension bridge depending on route
  if (routeType === 'gorge' || routeType === 'storm') {
    const archZ = startZ + length * 0.50;
    const archX = world.riverCenter(archZ);
    obstacles.push({
      id: 'canyon-arch',
      type: 'canyon_arch',
      position: { x: archX, y: world.groundHeight(archX, archZ), z: archZ },
      height: 82,
      span: 90,
      clearance: 46,
      radius: 20,
      bounds: { minX: archX - 55, maxX: archX + 55, minZ: archZ - 20, maxZ: archZ + 20 },
    });
  }

  return Object.freeze(obstacles);
}

export function checkObstacleCollisions(plane, obstacles) {
  if (!plane || !obstacles || plane.crashed) return null;
  const pos = plane.position;
  const wingRadius = 5.5;

  for (const obs of obstacles) {
    if (Math.abs(pos.z - obs.position.z) > 18) continue;
    const dx = pos.x - obs.position.x;
    const dz = pos.z - obs.position.z;
    const distSq = dx * dx + dz * dz;

    if (obs.type === 'radio_mast' || obs.type === 'power_pylon') {
      const topY = obs.position.y + obs.height;
      if (pos.y >= obs.position.y && pos.y <= topY && distSq < (obs.radius + wingRadius) ** 2) {
        return {
          hit: true,
          obstacle: obs,
          message: `Struck ${obs.type === 'radio_mast' ? 'broadcast tower' : 'power pylon'}!`,
        };
      }
    } else if (obs.type === 'canyon_arch') {
      // Collision with arch pillars or top slab (flying through arch is safe)
      const topY = obs.position.y + obs.height;
      const clearY = obs.position.y + obs.clearance;
      const hitLeft = Math.abs(pos.x - (obs.position.x - obs.span / 2)) < 12;
      const hitRight = Math.abs(pos.x - (obs.position.x + obs.span / 2)) < 12;
      const hitTop = pos.y > clearY && pos.y < topY + 10 && Math.abs(dx) < obs.span / 2;

      if ((hitLeft || hitRight || hitTop) && distSq < 400) {
        return { hit: true, obstacle: obs, message: 'Collision with canyon arch structure!' };
      }
    }
  }
  return null;
}

export function drawObstacles(ctx, obstacles, project, palette, time = 0) {
  if (!obstacles) return;

  for (const obs of obstacles) {
    const base = project({ x: obs.position.x, y: obs.position.y, z: obs.position.z });
    const top = project({ x: obs.position.x, y: obs.position.y + obs.height, z: obs.position.z });
    if (!base || !top) continue;

    ctx.save();
    if (obs.type === 'radio_mast') {
      // Tapered lattice tower
      const halfBase = (obs.radius ?? 5) * base.scale;
      const p1 = project({ x: obs.position.x - 4, y: obs.position.y, z: obs.position.z });
      const p2 = project({ x: obs.position.x + 4, y: obs.position.y, z: obs.position.z });
      if (p1 && p2) {
        ctx.strokeStyle = '#c8443b';
        ctx.lineWidth = Math.max(1.5, 2.5 * base.scale);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(top.x, top.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();

        // Cross bracing
        for (let h = 0.25; h <= 0.85; h += 0.25) {
          const cross = project({ x: obs.position.x, y: obs.position.y + obs.height * h, z: obs.position.z });
          if (cross) {
            ctx.strokeStyle = '#e6e6e6';
            ctx.beginPath();
            ctx.moveTo(cross.x - halfBase * (1 - h), cross.y);
            ctx.lineTo(cross.x + halfBase * (1 - h), cross.y);
            ctx.stroke();
          }
        }

        // Flashing red beacon light
        const flash = Math.sin(time * 6) > 0.1;
        ctx.fillStyle = flash ? '#ff2b2b' : '#701010';
        ctx.beginPath();
        ctx.arc(top.x, top.y, Math.max(3, 5 * top.scale), 0, Math.PI * 2);
        ctx.fill();
        if (flash) {
          ctx.strokeStyle = 'rgba(255, 60, 60, 0.4)';
          ctx.lineWidth = 4;
          ctx.stroke();
        }
      }
    } else if (obs.type === 'power_pylon') {
      ctx.strokeStyle = '#5a626d';
      ctx.lineWidth = Math.max(1.5, 2.0 * base.scale);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();

      // Crossbars
      const crossY = obs.position.y + obs.height * 0.85;
      const cLeft = project({ x: obs.position.x - 12, y: crossY, z: obs.position.z });
      const cRight = project({ x: obs.position.x + 12, y: crossY, z: obs.position.z });
      if (cLeft && cRight) {
        ctx.beginPath();
        ctx.moveTo(cLeft.x, cLeft.y);
        ctx.lineTo(cRight.x, cRight.y);
        ctx.stroke();
      }

      // Connecting power cables
      if (obs.connectedTo) {
        const destCross = project({ x: obs.connectedTo.x, y: crossY, z: obs.connectedTo.z });
        if (destCross && cRight) {
          ctx.strokeStyle = 'rgba(60, 65, 75, 0.7)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(cRight.x, cRight.y);
          // Sagging cable
          const midX = (cRight.x + destCross.x) / 2;
          const midY = (cRight.y + destCross.y) / 2 + 15 * base.scale;
          ctx.quadraticCurveTo(midX, midY, destCross.x, destCross.y);
          ctx.stroke();
        }
      }
    } else if (obs.type === 'canyon_arch') {
      // Natural rock arch spanning the canyon
      const leftPillar = project({ x: obs.position.x - obs.span / 2, y: obs.position.y, z: obs.position.z });
      const rightPillar = project({ x: obs.position.x + obs.span / 2, y: obs.position.y, z: obs.position.z });
      const archCrown = project({ x: obs.position.x, y: obs.position.y + obs.height, z: obs.position.z });
      const archUnderside = project({ x: obs.position.x, y: obs.position.y + obs.clearance, z: obs.position.z });

      if (leftPillar && rightPillar && archCrown && archUnderside) {
        ctx.fillStyle = '#9e563a';
        ctx.strokeStyle = '#7d412b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(leftPillar.x, leftPillar.y);
        ctx.quadraticCurveTo(archCrown.x, archCrown.y - 15 * archCrown.scale, rightPillar.x, rightPillar.y);
        ctx.lineTo(rightPillar.x - 10 * rightPillar.scale, rightPillar.y);
        ctx.quadraticCurveTo(archUnderside.x, archUnderside.y, leftPillar.x + 10 * leftPillar.scale, leftPillar.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
