#include "defines.hpp"

#ifdef GUI_CONFIG_SETUP

/*
 * Generic FluidX3D setup driven by a FluidX3D Studio setup config.
 *
 * The whole file is inactive unless GUI_CONFIG_SETUP is defined in
 * defines.hpp; the installer wraps the hand-written main_setup() in
 * setup.cpp in the matching #ifndef so exactly one of the two is compiled.
 *
 * Config schema, derived quantities, rotation order and coordinate
 * conventions are defined in CONTRACT.md sections 1 and 2. Anything changed
 * here has to be changed in web/js/derive.js as well.
 */

#include "setup.hpp"
#include "json.hpp"
#include "mesh_seal.hpp"

namespace {

/* ------------------------------------------------------------------ paths */

string to_forward_slashes(const string& path) {
	string result = path;
	for(uint i=0u; i<(uint)result.length(); i++) if(result[i]=='\\') result[i] = '/';
	return result;
}

bool is_absolute_path(const string& path) {
	if(path.length()>=1u&&path[0]=='/') return true;
	if(path.length()>=2u&&path[1]==':') return true; // Windows drive letter
	return false;
}

string parent_directory(const string& path) {
	const size_t slash = path.rfind('/');
	return slash==string::npos ? string("") : path.substr(0u, slash);
}

string join_path(const string& directory, const string& relative) {
	return directory=="" ? relative : directory+"/"+relative;
}

bool file_exists(const string& path) {
	if(path=="") return false;
	std::ifstream file(path, std::ios::in|std::ios::binary);
	return file.good();
}

/* Object files are stored relative to data/ (CONTRACT.md section 1). The
   setup config itself lives in data/setups/, so data/ is its grandparent. */
string resolve_object_file(const string& relative, const string& data_directory, const string& setup_directory) {
	if(is_absolute_path(relative)) return file_exists(relative) ? relative : string("");
	const string candidates[3] = {
		join_path(data_directory, relative),
		join_path(setup_directory, relative),
		get_exe_path()+relative
	};
	for(uint i=0u; i<3u; i++) if(file_exists(candidates[i])) return candidates[i];
	return "";
}

/* Keeps the export folder name safe for every file system. */
string sanitize_name(const string& name) {
	string result = "";
	for(uint i=0u; i<(uint)name.length(); i++) {
		const char c = name[i];
		const bool safe = (c>='0'&&c<='9')||(c>='A'&&c<='Z')||(c>='a'&&c<='z')||c=='-'||c=='_';
		result += safe ? c : '_';
	}
	return result=="" ? string("setup") : result;
}

/* --------------------------------------------------------------- geometry */

/* Rz(yaw)*Rx(pitch)*Ry(roll), applied about the object's own centre.
   euler() in web/js/derive.js must produce the identical matrix. */
float3x3 make_rotation(const float pitch_deg, const float yaw_deg, const float roll_deg) {
	const float3x3 rz = float3x3(float3(0.0f, 0.0f, 1.0f), radians(yaw_deg));
	const float3x3 rx = float3x3(float3(1.0f, 0.0f, 0.0f), radians(pitch_deg));
	const float3x3 ry = float3x3(float3(0.0f, 1.0f, 0.0f), radians(roll_deg));
	return rz*rx*ry;
}

/* Returns 0 for "periodic", which means the cell is left untouched. */
uchar boundary_flag(const string& face, const string& type) {
	if(type=="periodic") return (uchar)0u;
	if(type=="solid") return TYPE_S;
	if(type!="equilibrium"&&type!="open") print_warning("Unknown boundary type \""+type+"\" for "+face+"; using \"equilibrium\".");
	return TYPE_E; // "equilibrium" and "open" both fix the equilibrium distribution
}

#ifdef GRAPHICS
int visualization_flag(const string& mode) {
	if(mode=="solid") return VIS_FLAG_SURFACE;
	if(mode=="flags") return VIS_FLAG_LATTICE;
	if(mode=="field") return VIS_FIELD;
	if(mode=="streamlines") return VIS_STREAMLINES;
	if(mode=="q_criterion") return VIS_Q_CRITERION;
	return 0;
}
#endif // GRAPHICS

struct Moving_Object {
	Mesh* mesh = nullptr;
	float3 axis = float3(0.0f, 1.0f, 0.0f); // normalized rotation axis in domain coordinates
	float omega = 0.0f;                     // radians per LBM time step
	ulong interval = 1ull;                  // LBM steps between re-voxelisations
	ulong pending = 0ull;                   // steps run since the last re-voxelisation
};

/* A static object waiting to be sealed. The mesh is kept alive past the object
   loop on purpose: every voxelize_mesh_on_device() refreshes the host copy of
   lbm.flags from the device, so a seal written between two objects would be
   overwritten by the next one. Sealing therefore happens in one go once all
   static objects are voxelized. */
struct Seal_Job {
	Mesh* mesh = nullptr;
	string name = "";
	int mode = mesh_seal::SEAL_OFF;
	int close_holes = 0;
	int min_thickness = 1;
};

/* ------------------------------------------------------------- arguments */

/* Reads "--config <path>" from main_arguments and removes the pair, so the
   remaining arguments keep their meaning as OpenCL device IDs and
   "FluidX3D.exe 0 --config foo.json" still selects device 0. */
string take_config_path() {
	string path = "";
	for(uint i=0u; i<(uint)main_arguments.size(); i++) {
		if(main_arguments[i]!="--config") continue;
		const bool has_value = i+1u<(uint)main_arguments.size();
		if(has_value) path = main_arguments[i+1u];
		main_arguments.erase(main_arguments.begin()+(int)i, main_arguments.begin()+(int)i+(has_value ? 2 : 1));
		break;
	}
	if(path=="") {
		const string fallback = get_exe_path()+"config.json";
		if(file_exists(fallback)) {
			path = fallback;
		} else {
			print_error("No config given. Pass \"--config <path>\" or create \""+fallback+"\".");
		}
	}
	return to_forward_slashes(path);
}

} // namespace

void main_setup() { // generic setup driven by a FluidX3D Studio config; extensions come from the generated defines.hpp
	// ================================================== read config ==================================================
	const string config_path = take_config_path();
	const json::Document document = json::parse_file(config_path);
	if(!document.ok()) print_error("Could not read config \""+config_path+"\": "+document.error);
	const json::Value& cfg = document.root;
	if(!cfg.is_object()) print_error("Config \""+config_path+"\" does not contain a JSON object.");

	const string setup_name = sanitize_name(cfg["name"].as_string("setup"));

	// run.mode is a compile-time decision (defines.hpp); a hint about an outdated build helps with troubleshooting
#if defined(GRAPHICS)&&!defined(INTERACTIVE_GRAPHICS)
	const string compiled_mode = "render";
#elif defined(GRAPHICS)
	const string compiled_mode = "interactive";
#else // no graphics
	const string compiled_mode = "console";
#endif // GRAPHICS && !INTERACTIVE_GRAPHICS
	const string requested_mode = cfg["run"]["mode"].as_string(compiled_mode);
	if(requested_mode!=compiled_mode) print_warning("run.mode is \""+requested_mode+"\", but the build is \""+compiled_mode+"\". Please rebuild.");

	const string setup_directory = parent_directory(config_path);
	const string data_directory = parent_directory(setup_directory);

	// ================================================== domain, resolution, units ==================================================
	const float si_lx = fmax(cfg["domain"]["size_m"][0].as_float(36.0f), 1E-6f); // x spanwise
	const float si_ly = fmax(cfg["domain"]["size_m"][1].as_float(60.0f), 1E-6f); // y streamwise
	const float si_lz = fmax(cfg["domain"]["size_m"][2].as_float(18.0f), 1E-6f); // z up
	const uint target_vram = max(64u, cfg["domain"]["target_vram_mb"].as_uint(4000u));
	uint3 lbm_N = resolution(float3(si_lx, si_ly, si_lz), target_vram); // reference implementation for the numbers shown in the GUI
	lbm_N.x = max(2u, lbm_N.x);
	lbm_N.y = max(2u, lbm_N.y);
	lbm_N.z = max(2u, lbm_N.z);

	const float si_u = cfg["fluid"]["velocity_ms"].as_float(30.0f);
	const float si_nu = cfg["fluid"]["viscosity_m2s"].as_float(1.48E-5f);
	const float si_rho = cfg["fluid"]["density_kgm3"].as_float(1.225f);
	const float lbm_u = cfg["fluid"]["u_lbm"].as_float(0.075f);
	if(si_u<=0.0f) print_error("fluid.velocity_ms must be greater than 0.");
	if(si_nu<=0.0f) print_error("fluid.viscosity_m2s must be greater than 0.");
	if(si_rho<=0.0f) print_error("fluid.density_kgm3 must be greater than 0.");
	if(lbm_u<=0.0f||lbm_u>0.4f) print_error("fluid.u_lbm must be between 0 and 0.4.");

	units.set_m_kg_s((float)lbm_N.x, lbm_u, 1.0f, si_lx, si_u, si_rho); // 1 cell = si_lx/Nx metres
	const float lbm_nu = units.nu(si_nu);
	const float lbm_tau = 3.0f*lbm_nu+0.5f;
	const float si_cell = units.si_x(1.0f);
	const float si_dt = units.si_t(1ull);
	const float si_reference = fmax(cfg["reference"]["length_m"].as_float(si_lx), 1E-6f);

	print_info("Setup \""+setup_name+"\" from \""+config_path+"\"");
	print_info("Grid "+to_string(lbm_N.x)+" x "+to_string(lbm_N.y)+" x "+to_string(lbm_N.z)+" = "+to_string((ulong)lbm_N.x*(ulong)lbm_N.y*(ulong)lbm_N.z)+" cells");
	print_info("Box "+to_string(si_lx, 2u)+" x "+to_string(si_ly, 2u)+" x "+to_string(si_lz, 2u)+" m, cell size "+to_string(1000.0f*si_cell, 3u)+" mm");
	print_info("Time step "+to_string(si_dt)+" s, u_lbm = "+to_string(lbm_u, 4u));
	print_info("Re = "+to_string(to_uint(units.si_Re(si_reference, si_u, si_nu)))+" at "+to_string(si_reference, 3u)+" m reference length and "+to_string(si_u, 2u)+" m/s");
	print_info("nu_lbm = "+to_string(lbm_nu, 8u)+", tau = "+to_string(lbm_tau, 6u));
	if(lbm_tau<0.5005f) print_warning("tau is very close to 0.5, the simulation may become unstable. Reduce u_lbm or raise the VRAM target.");

	LBM lbm(lbm_N, 1u, 1u, 1u, lbm_nu);

	// ================================================== load and voxelize objects ==================================================
	const json::Value& objects = cfg["objects"];
	vector<Moving_Object> moving;
	vector<Seal_Job> sealing_jobs;
	bool moving_seal_notice = false; // the hint about unsealed moving objects is printed at most once
	for(std::size_t index=0u; index<objects.size(); index++) {
		const json::Value& object = objects[index];
		const string object_name = object["name"].as_string("Object "+to_string((uint)index+1u));
		if(!object["enabled"].as_bool(true)) continue;
		const string type = object["type"].as_string("stl");
		if(type!="stl") {
			print_warning("Object \""+object_name+"\": type \""+type+"\" is not supported, skipping.");
			continue;
		}
		/* sealing.sealed_file is a leftover from the old workflow, in which the
		   server pre-computed a thickened STL for one fixed cell size and
		   pointed "file" at it. That geometry was frozen at that cell size, so a
		   finer run got *coarser* geometry than the original. Sealing now
		   happens at runtime, so "source_file" — the upload the object was built
		   from — is what gets loaded. validateObject() in web/js/schema.js does
		   the same substitution; this is for setup files that never passed
		   through the new frontend. A missing or unreadable source file is never
		   an error: the configured file simply stays. */
		string relative = to_forward_slashes(object["file"].as_string(""));
		const string source_relative = to_forward_slashes(object["source_file"].as_string(""));
		if(source_relative!=""&&source_relative!=relative&&resolve_object_file(source_relative, data_directory, setup_directory)!="") {
			const bool has_legacy_seal = to_forward_slashes(object["sealing"]["sealed_file"].as_string(""))!="";
			print_info("Object \""+object_name+"\": "+(has_legacy_seal ? string("ignoring the pre-computed sealed file, using") : string("using"))+" the source file \""+source_relative+"\".");
			relative = source_relative;
		}
		if(relative=="") {
			print_warning("Object \""+object_name+"\": no file given, skipping.");
			continue;
		}
		const string file = resolve_object_file(relative, data_directory, setup_directory);
		if(file=="") {
			print_warning("Object \""+object_name+"\": file \""+relative+"\" not found, skipping.");
			continue;
		}

		Mesh* mesh = read_stl(file); // unscaled and unrotated; STL units are metres
		const float si_longest_edge = mesh->get_max_size();
		if(si_longest_edge<=0.0f) {
			print_warning("Object \""+object_name+"\": mesh has zero extent, skipping.");
			delete mesh;
			continue;
		}
		const string sizing_mode = object["sizing"]["mode"].as_string("scale");
		const float sizing_value = object["sizing"]["value"].as_float(1.0f);
		float si_scale = 1.0f;
		if(sizing_mode=="longest_edge_m") {
			si_scale = sizing_value/si_longest_edge;
		} else {
			if(sizing_mode!="scale") print_warning("Object \""+object_name+"\": unknown sizing mode \""+sizing_mode+"\"; using \"scale\".");
			si_scale = sizing_value;
		}
		if(si_scale<=0.0f) {
			print_warning("Object \""+object_name+"\": scale must be greater than 0, skipping.");
			delete mesh;
			continue;
		}
		mesh->scale(si_scale*units.x(1.0f)); // metres -> lattice cells

		mesh->set_center(mesh->get_bounding_box_center()); // rotate about the object's own centre
		mesh->rotate(make_rotation(object["rotation_deg"]["pitch"].as_float(0.0f), object["rotation_deg"]["yaw"].as_float(0.0f), object["rotation_deg"]["roll"].as_float(0.0f)));
		const float3 target = float3( // position_frac counts from the lower corner of the box
			object["position_frac"][0].as_float(0.5f)*(float)lbm_N.x-0.5f,
			object["position_frac"][1].as_float(0.5f)*(float)lbm_N.y-0.5f,
			object["position_frac"][2].as_float(0.5f)*(float)lbm_N.z-0.5f
		);
		mesh->translate(target-mesh->get_bounding_box_center());
		mesh->set_center(mesh->get_bounding_box_center()); // the rotation axis of moving objects passes through the bbox centre

		/* Sealing (CONTRACT.md section 8). close_holes and min_thickness are
		   clamped inside mesh_seal; an unknown mode simply means "off". */
		const string seal_mode_name = object["sealing"]["mode"].as_string("off");
		const int seal_mode = mesh_seal::mode_from_string(seal_mode_name);
		if(seal_mode==mesh_seal::SEAL_OFF&&seal_mode_name!="off"&&seal_mode_name!="") print_warning("Object \""+object_name+"\": unknown sealing mode \""+seal_mode_name+"\"; not sealing.");
		const int seal_close_holes = object["sealing"]["close_holes"].as_int(1);
		const int seal_min_thickness = object["sealing"]["min_thickness"].as_int(1);

		const string motion_type = object["motion"]["type"].as_string("none");
		const float rpm = object["motion"]["rpm"].as_float(0.0f);
		if(motion_type=="rotate"&&rpm!=0.0f) {
			float3 axis = float3(object["motion"]["axis"][0].as_float(0.0f), object["motion"]["axis"][1].as_float(1.0f), object["motion"]["axis"][2].as_float(0.0f));
			if(length(axis)<=0.0f) axis = float3(0.0f, 1.0f, 0.0f);
			Moving_Object rotor;
			rotor.mesh = mesh;
			rotor.axis = normalize(axis);
			rotor.omega = units.omega(rpm*2.0f*pif/60.0f); // rad/s -> rad per time step
			rotor.interval = max(1u, object["motion"]["revoxelize_interval"].as_uint(4u));
			moving.push_back(rotor);
			print_info("Object \""+object_name+"\": rotating at "+to_string(rpm, 1u)+" rpm ("+to_string(rotor.omega, 6u)+" rad/step), re-voxelized every "+to_string(rotor.interval)+" steps");
			// Moving objects are re-voxelized every few steps; sealing on every step would be too expensive.
			if(seal_mode!=mesh_seal::SEAL_OFF&&!moving_seal_notice) {
				print_info("Moving objects are not sealed, because they are re-voxelized over and over during the run. For them, thin blades remain a matter of resolution.");
				moving_seal_notice = true;
			}
		} else {
			lbm.voxelize_mesh_on_device(mesh); // TYPE_S, static
			if(seal_mode!=mesh_seal::SEAL_OFF) { // the mesh is freed after sealing
				Seal_Job job;
				job.mesh = mesh;
				job.name = object_name;
				job.mode = seal_mode;
				job.close_holes = seal_close_holes;
				job.min_thickness = seal_min_thickness;
				sealing_jobs.push_back(job);
			} else {
				delete mesh;
			}
		}
	}
#ifndef MOVING_BOUNDARIES
	if(!moving.empty()) print_warning("Moving objects need the MOVING_BOUNDARIES extension in defines.hpp.");
#endif // MOVING_BOUNDARIES

	// ================================================== sealing ==================================================
	/* Runs after every static object has been voxelized, because
	   voxelize_mesh_on_device() reads lbm.flags back from the device and would
	   otherwise discard a seal written in between. And it runs before the
	   inflow below, because that loop skips TYPE_S cells — so sealed cells keep
	   u = 0 like every other solid cell instead of being dragged along with the
	   flow. Details in CONTRACT.md section 8 and in mesh_seal.hpp. */
	for(uint i=0u; i<(uint)sealing_jobs.size(); i++) {
		const Seal_Job& job = sealing_jobs[i];
		mesh_seal::seal_mesh_into_flags(lbm, job.mesh, TYPE_S, job.mode, job.close_holes, job.min_thickness, job.name);
		delete job.mesh;
	}
	sealing_jobs.clear();

	// ================================================== inflow and boundary conditions ==================================================
	const float azimuth = radians(cfg["fluid"]["azimuth_deg"].as_float(0.0f));    // 0 = flow towards +y
	const float elevation = radians(cfg["fluid"]["elevation_deg"].as_float(0.0f)); // positive = tilted upwards
	const float3 lbm_inflow = lbm_u*float3(sin(azimuth)*cos(elevation), cos(azimuth)*cos(elevation), sin(elevation));

	const uchar bc_xmin = boundary_flag("xmin", cfg["boundaries"]["xmin"].as_string("equilibrium"));
	const uchar bc_xmax = boundary_flag("xmax", cfg["boundaries"]["xmax"].as_string("equilibrium"));
	const uchar bc_ymin = boundary_flag("ymin", cfg["boundaries"]["ymin"].as_string("equilibrium"));
	const uchar bc_ymax = boundary_flag("ymax", cfg["boundaries"]["ymax"].as_string("equilibrium"));
	const uchar bc_zmin = boundary_flag("zmin", cfg["boundaries"]["zmin"].as_string("equilibrium"));
	const uchar bc_zmax = boundary_flag("zmax", cfg["boundaries"]["zmax"].as_string("equilibrium"));

	const uint Nx=lbm.get_Nx(), Ny=lbm.get_Ny(), Nz=lbm.get_Nz();
	parallel_for(lbm.get_N(), [&](ulong n) { uint x=0u, y=0u, z=0u; lbm.coordinates(n, x, y, z);
		if(lbm.flags[n]!=TYPE_S) { // inflow velocity everywhere there is no solid
			lbm.u.x[n] = lbm_inflow.x;
			lbm.u.y[n] = lbm_inflow.y;
			lbm.u.z[n] = lbm_inflow.z;
		}
		if(x==0u    &&bc_xmin!=0u) lbm.flags[n] = bc_xmin; // 0 = periodic, the cell is left untouched
		if(x==Nx-1u &&bc_xmax!=0u) lbm.flags[n] = bc_xmax;
		if(y==0u    &&bc_ymin!=0u) lbm.flags[n] = bc_ymin;
		if(y==Ny-1u &&bc_ymax!=0u) lbm.flags[n] = bc_ymax;
		if(z==0u    &&bc_zmin!=0u) lbm.flags[n] = bc_zmin;
		if(z==Nz-1u &&bc_zmax!=0u) lbm.flags[n] = bc_zmax;
	});

	// ================================================== visualization ==================================================
#ifdef GRAPHICS
	const json::Value& modes = cfg["visualization"]["modes"];
	int visualization_modes = 0;
	for(std::size_t index=0u; index<modes.size(); index++) {
		const string mode = modes[index].as_string("");
		const int flag = visualization_flag(mode);
		if(flag==0) print_warning("Ignoring unknown visualization mode \""+mode+"\".");
		visualization_modes |= flag;
	}
	if(visualization_modes==0) visualization_modes = VIS_FLAG_SURFACE; // without a mode the image would stay empty
	lbm.graphics.visualization_modes = visualization_modes;
	// visualization.q_criterion, .u_max and .background are compile-time constants and live in the generated defines.hpp
#endif // GRAPHICS

	// ================================================== simulation ==================================================
#if defined(GRAPHICS)&&!defined(INTERACTIVE_GRAPHICS)
	const float si_duration = fmax(cfg["run"]["duration_s"].as_float(4.0f), 1E-3f);
	const ulong lbm_T = max((ulong)1u, units.t(si_duration));
	const uint fps = max(1u, cfg["run"]["fps"].as_uint(60u));
	const uint frames = max(1u, to_uint(si_duration*(float)fps));
	const float video_seconds = (float)frames/60.0f; // next_frame() works in terms of 60 fps video
	const string export_path = get_exe_path()+"export/"+setup_name+"/";
	const string camera_type = cfg["run"]["camera"]["type"].as_string("orbit");
	const float camera_from = cfg["run"]["camera"]["azimuth_from_deg"].as_float(-70.0f);
	const float camera_to = cfg["run"]["camera"]["azimuth_to_deg"].as_float(70.0f);
	const float camera_elevation = cfg["run"]["camera"]["elevation_deg"].as_float(20.0f);
	const float camera_fov = cfg["run"]["camera"]["distance"].as_float(60.0f);
	const float camera_zoom = cfg["run"]["camera"]["zoom"].as_float(1.3f);
	auto write_camera_frame = [&]() {
		const float progress = (float)lbm.get_t()/(float)lbm_T; // 0..1
		const float azimuth_deg = camera_type=="fixed" ? camera_from : camera_from+(camera_to-camera_from)*progress;
		lbm.graphics.set_camera_centered(azimuth_deg, camera_elevation, camera_fov, camera_zoom);
		lbm.graphics.write_frame(export_path);
	};
	print_info("Render mode: "+to_string(frames)+" frames over "+to_string(si_duration, 2u)+" s to \""+export_path+"\"");
#else // interactive: P = start/pause, mouse = camera, H = help
	const ulong lbm_T = max_ulong;
#endif // GRAPHICS && !INTERACTIVE_GRAPHICS

	if(moving.empty()) {
#if defined(GRAPHICS)&&!defined(INTERACTIVE_GRAPHICS)
		lbm.run(0u, lbm_T);
		while(lbm.get_t()<lbm_T&&running) {
			if(lbm.graphics.next_frame(lbm_T, video_seconds)) write_camera_frame();
			lbm.run(1u, lbm_T);
		}
		lbm.write_status();
#else // interactive
		lbm.run();
#endif // GRAPHICS && !INTERACTIVE_GRAPHICS
	} else {
		lbm.run(0u, lbm_T); // initialize, then drive the time loop ourselves
		for(uint i=0u; i<(uint)moving.size(); i++) {
			const Moving_Object& rotor = moving[i];
			lbm.voxelize_mesh_on_device(rotor.mesh, TYPE_S, rotor.mesh->get_center(), float3(0.0f), rotor.axis*rotor.omega);
		}
		while(lbm.get_t()<lbm_T&&running) {
			ulong steps = 0ull; // run until the next re-voxelization is due
			for(uint i=0u; i<(uint)moving.size(); i++) {
				const Moving_Object& rotor = moving[i];
				const ulong remaining = rotor.interval>rotor.pending ? rotor.interval-rotor.pending : 1ull;
				if(steps==0ull||remaining<steps) steps = remaining;
			}
			lbm.run(steps, lbm_T);
			for(uint i=0u; i<(uint)moving.size(); i++) {
				Moving_Object& rotor = moving[i];
				rotor.pending += steps;
				if(rotor.pending<rotor.interval) continue;
				rotor.mesh->rotate(float3x3(rotor.axis, rotor.omega*(float)rotor.pending)); // rotate by exactly the elapsed time
				lbm.voxelize_mesh_on_device(rotor.mesh, TYPE_S, rotor.mesh->get_center(), float3(0.0f), rotor.axis*rotor.omega); // also clears the old cells inside the bbox
				rotor.pending = 0ull;
			}
#if defined(GRAPHICS)&&!defined(INTERACTIVE_GRAPHICS)
			if(lbm.graphics.next_frame(lbm_T, video_seconds)) write_camera_frame();
#endif // GRAPHICS && !INTERACTIVE_GRAPHICS
		}
#if defined(GRAPHICS)&&!defined(INTERACTIVE_GRAPHICS)
		lbm.write_status();
#endif // GRAPHICS && !INTERACTIVE_GRAPHICS
		for(uint i=0u; i<(uint)moving.size(); i++) delete moving[i].mesh;
	}
}

#endif // GUI_CONFIG_SETUP
