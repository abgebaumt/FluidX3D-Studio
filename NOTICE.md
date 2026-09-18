# Licensing notice

FluidX3D Studio
Copyright (C) 2026 Tim Stuhler

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program (`LICENSE`). If not, see <https://www.gnu.org/licenses/>.

## Additional permission under GNU AGPL version 3 section 7

FluidX3D Studio is a front end for FluidX3D. Part of it (`solver/`) is compiled
into FluidX3D, whose license is not compatible with the AGPL. To make that
combination possible, the following additional permission applies:

> If you modify this Program, or any covered work, by linking or combining it
> with FluidX3D (https://github.com/ProjectPhysX/FluidX3D), or a modified
> version of FluidX3D, containing parts covered by the terms of the FluidX3D
> license, the licensors of this Program grant you additional permission to
> convey the resulting work. Corresponding Source for a non-source form of such
> a combination shall include the source code for the parts of FluidX3D used as
> well as that of the covered work.

This permission does not change the terms of FluidX3D itself. Any binary that
contains FluidX3D — which is every build the studio produces — remains subject
to the FluidX3D license, including its ban on commercial and military use.

## Third-party components

| Component | Where | License |
|---|---|---|
| [FluidX3D](https://github.com/ProjectPhysX/FluidX3D) by Dr. Moritz Lehmann | git submodule `fluidx3d/`, not part of this repository | FluidX3D license, see [`LICENSES/FluidX3D.md`](LICENSES/FluidX3D.md) |
| Altered FluidX3D sources | `server/defines.template.hpp`, `solver/patches/*.patch` | FluidX3D license, see [`LICENSES/FluidX3D.md`](LICENSES/FluidX3D.md) |
| [three.js](https://threejs.org/) | npm dependency | MIT |
| [Express](https://expressjs.com/) | npm dependency | MIT |
| [multer](https://github.com/expressjs/multer) | npm dependency | MIT |

The files listed as altered FluidX3D sources are marked as such at their top.
They are not covered by the AGPL. Everything else in this repository is.

"FluidX3D" is a name protected by Dr. Moritz Lehmann. FluidX3D Studio is an
independent, unofficial project and is not affiliated with or endorsed by the
author of FluidX3D.
