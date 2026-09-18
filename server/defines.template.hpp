#pragma once
// Altered version of src/defines.hpp from FluidX3D (https://github.com/ProjectPhysX/FluidX3D),
// Copyright (c) 2022-2026 Dr. Moritz Lehmann. Modified by FluidX3D Studio, which replaces the
// options it controls with generated lines. This file is not part of the original software and
// is licensed under the FluidX3D license, see LICENSES/FluidX3D.md in the FluidX3D Studio repository.



{{VELOCITY_SET}}

{{COLLISION}}

{{PRECISION}}

//#define BENCHMARK // disable all extensions and setups and run benchmark setup instead

{{EXTENSIONS}}

#define GUI_CONFIG_SETUP // FluidX3D Studio: build the scene from the JSON handed over with --config instead of a hard-coded main_setup()
{{GRAPHICS_MODE}}

#define GRAPHICS_FRAME_WIDTH 1920 // set frame width if only GRAPHICS is enabled
#define GRAPHICS_FRAME_HEIGHT 1080 // set frame height if only GRAPHICS is enabled
{{GRAPHICS_BACKGROUND_COLOR}}
{{GRAPHICS_U_MAX}}
#define GRAPHICS_RHO_DELTA 0.001f // coloring range for density rho will be [1.0f-GRAPHICS_RHO_DELTA, 1.0f+GRAPHICS_RHO_DELTA] (default: 0.001f)
#define GRAPHICS_T_DELTA 1.0f // coloring range for temperature T will be [1.0f-GRAPHICS_T_DELTA, 1.0f+GRAPHICS_T_DELTA] (default: 1.0f)
#define GRAPHICS_F_MAX 0.001f // maximum force in LBM units for visualization of forces on solid boundaries if VOLUME_FORCE is enabled and lbm.update_force_field(); is called (default: 0.001f)
{{GRAPHICS_Q_CRITERION}}
#define GRAPHICS_STREAMLINE_SPARSE 8u // set how many streamlines there are every x lattice points
#define GRAPHICS_STREAMLINE_LENGTH 128u // set maximum length of streamlines
#define GRAPHICS_RAYTRACING_TRANSMITTANCE 0.25f // transmitted light fraction in raytracing graphics ("0.25f" = 1/4 of light is transmitted and 3/4 is absorbed along longest box side length, "1.0f" = no absorption)
#define GRAPHICS_RAYTRACING_COLOR 0x005F7F // absorption color of fluid in raytracing graphics
#define GRAPHICS_LSF 4u // local box size for local memory optimization in graphics_flags_mc() kernel, possible values: 0u (disable local memory optimization), 4u (default, ~40% speedup), 8u (~40% speedup)
#define GRAPHICS_LSQ 8u // local box size for local memory optimization in graphics_q() kernel, possible values: 0u (disable local memory optimization), 4u (no speedup), 8u (default, ~10-90% speedup)
#define GRAPHICS_LSP 4u // local box size for local memory optimization in graphics_rasterize_phi() kernel, possible values: 0u (disable local memory optimization), 4u (default, ~40% speedup), 8u (~40% speedup)

//#define GRAPHICS_TRANSPARENCY 0.7f // optional: comment/uncomment this line to disable/enable semi-transparent rendering (looks better but reduces framerate), number represents transparency (equal to 1-opacity) (default: 0.7f)



// #############################################################################################################

#define TYPE_S 0b00000001 // (stationary or moving) solid boundary
#define TYPE_E 0b00000010 // equilibrium boundary (inflow/outflow)
#define TYPE_T 0b00000100 // temperature boundary
#define TYPE_F 0b00001000 // fluid
#define TYPE_I 0b00010000 // interface
#define TYPE_G 0b00100000 // gas
#define TYPE_X 0b01000000 // reserved type X
#define TYPE_Y 0b10000000 // reserved type Y

#define VIS_FLAG_LATTICE  0b00000001 // lbm.graphics.visualization_modes = VIS_...|VIS_...|VIS_...;
#define VIS_FLAG_SURFACE  0b00000010
#define VIS_FIELD         0b00000100
#define VIS_STREAMLINES   0b00001000
#define VIS_Q_CRITERION   0b00010000
#define VIS_PHI_RASTERIZE 0b00100000
#define VIS_PHI_RAYTRACE  0b01000000
#define VIS_PARTICLES     0b10000000

#if defined(FP16S) || defined(FP16C)
#define fpxx ushort
#else // FP32
#define fpxx float
#endif // FP32

#ifdef BENCHMARK
#undef UPDATE_FIELDS
#undef VOLUME_FORCE
#undef FORCE_FIELD
#undef MOVING_BOUNDARIES
#undef EQUILIBRIUM_BOUNDARIES
#undef SURFACE
#undef TEMPERATURE
#undef SUBGRID
#undef PARTICLES
#undef INTERACTIVE_GRAPHICS
#undef INTERACTIVE_GRAPHICS_ASCII
#undef GRAPHICS
#endif // BENCHMARK

#ifdef SURFACE // (rho, u) need to be updated exactly every LBM step
#define UPDATE_FIELDS // update (rho, u, T) in every LBM step
#endif // SURFACE

#ifdef TEMPERATURE
#define VOLUME_FORCE
#endif // TEMPERATURE

#ifdef PARTICLES // (rho, u) need to be updated exactly every LBM step
#define UPDATE_FIELDS // update (rho, u, T) in every LBM step
#endif // PARTICLES

#if defined(INTERACTIVE_GRAPHICS) || defined(INTERACTIVE_GRAPHICS_ASCII)
#define GRAPHICS
#define UPDATE_FIELDS // to prevent flickering artifacts in interactive graphics
#endif // INTERACTIVE_GRAPHICS || INTERACTIVE_GRAPHICS_ASCII
