"""Skovern hero icon: a glass squircle with a warm orange core and a white S.

Rendered with Blender 5.2.3 (portable build) and Cycles. Reproduce from the repo root:

    blender -b -P apps/www/art/icon.py -- --mode frames     --out <dir>   # f-000.png ... (transparent, contact shadow in alpha)
    blender -b -P apps/www/art/icon.py -- --mode still      --out <dir>   # still.png, frame 0 at more samples
    blender -b -P apps/www/art/icon.py -- --mode front      --out <dir>   # front.png, 512 px, no floor, for light backgrounds
    blender -b -P apps/www/art/icon.py -- --mode front-dark --out <dir>   # front-dark.png, lit for a black backdrop
    blender -b -P apps/www/art/icon.py -- --mode og         --out <dir>   # og.png, 1200x630 transparent

Optional flags: --samples N, --frames N (default 72), --res N (default 1200), --cpu,
--font <ttf> (or SKOVERN_ICON_FONT). The S is the font's own glyph outline. The
shipped renders use Inter Bold (SIL Open Font License; the static TTF from Google
Fonts, Inter v20, wght 700); without --font it falls back to Segoe UI Bold on Windows.

Then convert the PNGs to WebP (and flatten the OG card onto #f5f5f7) with
`node apps/www/art/encode.mjs <render dir>`, which shells out to ffmpeg (libwebp).

The page scrubs f-000..f-071 on scroll: frame 0 is the resting three-quarter pose, the
last frame has turned to the other side. The yaw is linear in the frame number, and at rest
the page sways through the first frames. GPU: HIP (AMD) when available, else CPU with the
OpenImageDenoise denoiser (pass --cpu to force it; CPU defaults to 48 samples).

Last run (loop 054, camera above the tile): Blender 5.2.3 portable (blender-5.2.3-windows-x64.zip
from download.blender.org, no installer needed), HIP on a Radeon RX 7900 XTX, 128 samples a
frame, 72 frames in about 9 minutes. Encoded: 72 x 1200 px WebP frames, 3.6 MB in total.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

ORANGE = (0.807, 0.195, 0.026)  # linear #e87a2e
FONT = ""  # set from --font in main()
WARM = (1.0, 0.42, 0.12)


# ---------- args ----------
def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--mode", default="still", choices=["frames", "still", "front", "front-dark", "og"])
    p.add_argument("--out", required=True)
    p.add_argument("--samples", type=int, default=0)
    p.add_argument("--frames", type=int, default=72)
    p.add_argument("--res", type=int, default=1200)
    p.add_argument("--cpu", action="store_true")
    p.add_argument("--font", default=os.environ.get("SKOVERN_ICON_FONT", "C:/Windows/Fonts/segoeuib.ttf"))
    return p.parse_args(argv)


# ---------- scene ----------
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def use_device(force_cpu):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    if force_cpu:
        return "CPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("HIP", "OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.refresh_devices()
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            scene.cycles.device = "GPU"
            return kind
    return "CPU"


def squircle_points(w, h, n=5.0, seg=192):
    pts = []
    for i in range(seg):
        t = i / seg * math.tau
        c, s = math.cos(t), math.sin(t)
        x = w / 2 * math.copysign(abs(c) ** (2 / n), c)
        y = h / 2 * math.copysign(abs(s) ** (2 / n), s)
        pts.append((x, y))
    return pts


def squircle_slab(name, w, depth, bevel, segs, n=5.0):
    """A squircle prism, centred on z=0, with a rounded (beveled) rim."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts = [bm.verts.new((x, y, -depth / 2)) for x, y in squircle_points(w, w, n)]
    face = bm.faces.new(verts)
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    top = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=top, vec=(0, 0, depth))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if bevel > 0:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segs
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(40)
        mod.profile = 0.5
        mod.harden_normals = False
    for poly in mesh.polygons:
        poly.use_smooth = True
    return obj


def s_glyph(font_path, height, depth):
    """The Skovern S from a real typeface outline (Inter Bold by default): the
    font's own "S" as a curve, extruded and lightly bevelled, then scaled so the
    glyph is `height` tall and centred on the tile. A typeface S has the larger
    bowl at the bottom; the old hand-drawn stroke had it the wrong way round."""
    font = bpy.data.fonts.load(font_path)
    cu = bpy.data.curves.new("S", "FONT")
    cu.body = "S"
    cu.font = font
    cu.size = 1.0
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.resolution_u = 24
    cu.extrude = 0.06
    cu.bevel_depth = 0.022
    cu.bevel_resolution = 6
    obj = bpy.data.objects.new("S", cu)
    bpy.context.collection.objects.link(obj)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    s = bpy.context.active_object
    # Centre on the glyph's own bounds (fonts centre on the em box, not the ink).
    xs = [v.co.x for v in s.data.vertices]
    ys = [v.co.y for v in s.data.vertices]
    zs = [v.co.z for v in s.data.vertices]
    cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
    k = height / (max(ys) - min(ys))
    kz = depth / (max(zs) - min(zs))
    for v in s.data.vertices:
        v.co.x = (v.co.x - cx) * k
        v.co.y = (v.co.y - cy) * k
        v.co.z = (v.co.z - cz) * kz
    bpy.ops.object.shade_smooth()
    return s


# ---------- materials ----------
def node_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    return m, nt, out


def glass_mat():
    m, nt, out = node_mat("glass")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = (1, 1, 1, 1)
    b.inputs["Roughness"].default_value = 0.035
    b.inputs["IOR"].default_value = 1.5
    b.inputs["Transmission Weight"].default_value = 1.0
    b.inputs["Coat Weight"].default_value = 0.0
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    vol = nt.nodes.new("ShaderNodeVolumeAbsorption")
    vol.inputs["Color"].default_value = (1.0, 0.86, 0.74, 1)
    vol.inputs["Density"].default_value = 0.35
    nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])
    return m


def core_mat():
    """Orange body: glossy orange with a warm glow that is brightest in the middle."""
    m, nt, out = node_mat("core")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = (*ORANGE, 1)
    b.inputs["Roughness"].default_value = 0.45
    # a low specular level keeps the studio from washing the orange out to salmon
    b.inputs["Specular IOR Level"].default_value = 0.12
    b.inputs["Coat Weight"].default_value = 0.0
    tc = nt.nodes.new("ShaderNodeTexCoord")
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "SPHERICAL"
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.7, 1.7, 1.7)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], grad.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.5, 0.075, 0.004, 1)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (1.0, 0.27, 0.02, 1)
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Emission Color"])
    b.inputs["Emission Strength"].default_value = 0.9
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    return m


def s_mat():
    m, nt, out = node_mat("s")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = (1, 1, 1, 1)
    b.inputs["Roughness"].default_value = 0.22
    b.inputs["Emission Color"].default_value = (1.0, 0.93, 0.85, 1)
    b.inputs["Emission Strength"].default_value = 0.95
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    return m


# ---------- build ----------
def build_icon():
    pivot = bpy.data.objects.new("pivot", None)
    bpy.context.collection.objects.link(pivot)

    glass = squircle_slab("glass", 1.0, 0.30, 0.11, 14)
    glass.data.materials.append(glass_mat())

    core = squircle_slab("core", 0.87, 0.15, 0.05, 8)
    core.location = (0, 0, -0.03)
    core.data.materials.append(core_mat())

    s = s_glyph(FONT, 0.56, 0.05)
    s.location = (0, 0, 0.065)
    s.data.materials.append(s_mat())

    tile = bpy.data.objects.new("tile", None)  # local frame: XY face, +Z toward the viewer
    bpy.context.collection.objects.link(tile)
    for o in (glass, core, s):
        o.parent = tile
    tile.rotation_euler = (math.radians(90), 0, 0)  # stand it up, facing -Y
    tile.parent = pivot
    return pivot


def area(name, loc, size, size_y, energy, color=(1, 1, 1), target=(0, 0, 0), shadow=True):
    ld = bpy.data.lights.new(name, "AREA")
    ld.shape = "RECTANGLE"
    ld.size = size
    ld.size_y = size_y
    ld.energy = energy
    ld.color = color
    # only the key and top light draw the contact shadow; side lights would streak the floor
    ld.use_shadow = shadow
    o = bpy.data.objects.new(name, ld)
    bpy.context.collection.objects.link(o)
    o.location = loc
    d = Vector(target) - Vector(loc)
    o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return o


def studio(dark):
    # large soft key, upper left, high: the tile leans back toward it, and a lower
    # key would mirror in the face as a glare band across the S
    area("key", (-3.0, -0.9, 4.6), 3.0, 3.0, 1100 if not dark else 900, (1.0, 0.97, 0.93))
    # rim strips: tall and thin, behind left and right, to draw the glass edges
    area("rimL", (-2.4, 1.8, 0.4), 0.25, 4.0, 520, (1.0, 0.95, 0.9), shadow=False)
    area("rimR", (2.5, 1.6, 0.6), 0.25, 4.0, 620, (0.92, 0.95, 1.0), shadow=False)
    # top strip for the upper bevel highlight
    area("top", (0.0, -0.6, 3.0), 3.0, 0.3, 260)
    # soft fill from the right front
    area("fill", (3.2, -3.2, 0.2), 2.5, 2.5, 220 if not dark else 120, (0.95, 0.96, 1.0), shadow=False)

    world = bpy.data.worlds.new("world")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    # what the glass refracts and reflects: light grey studio paper, or near-black for dark sections
    bg.inputs["Color"].default_value = (0.003, 0.003, 0.0035, 1) if dark else (0.91, 0.91, 0.93, 1)
    bg.inputs["Strength"].default_value = 1.0 if dark else 0.35


def floor():
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -0.66))
    f = bpy.context.active_object
    f.is_shadow_catcher = True
    return f


def camera(lens, loc, target):
    cd = bpy.data.cameras.new("cam")
    cd.lens = lens
    o = bpy.data.objects.new("cam", cd)
    bpy.context.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = o
    return o


def setup_render(res_x, res_y, samples, device):
    sc = bpy.context.scene
    sc.render.resolution_x = res_x
    sc.render.resolution_y = res_y
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.cycles.film_transparent_glass = False
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.01
    sc.cycles.use_denoising = True
    sc.cycles.denoiser = "OPENIMAGEDENOISE"
    sc.cycles.max_bounces = 16
    sc.cycles.transmission_bounces = 16
    sc.cycles.glossy_bounces = 8
    sc.cycles.transparent_max_bounces = 16
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    sc.cycles.blur_glossy = 0.6
    sc.cycles.sample_clamp_indirect = 8.0
    # Khronos PBR Neutral keeps the brand orange saturated (AgX drifts it toward salmon)
    # while still rolling off the glass highlights instead of clipping them.
    sc.view_settings.view_transform = "Khronos PBR Neutral"
    sc.view_settings.exposure = 0.0
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.render.film_transparent = True
    print(f"[icon] device={device} samples={samples} res={res_x}x{res_y}")


# Resting hero pose and where the scrub ends. The camera sits above the tile and
# looks down (CAM_FRAMES), the way product stills are shot. The tile leans back
# a little MORE than the camera looks down (pitch < 0 tips the top away), so its
# bottom edge is nearer the lens and the S's bottom bowl renders at least as big
# as the top one at every frame. Tipping the top toward the camera, as loop 053
# did, made the top bowl bigger and the S read upside down.
YAW0, YAW1 = -26.0, 32.0
PITCH0, PITCH1 = -26.0, -24.0
CAM_FRAMES = ((0, -5.0, 1.75), (0, 0, -0.06))


def pose(pivot, t):
    # Linear in t: the page eases the scroll itself, and its idle sway steps
    # through the first frames at an even angle per frame.
    # ZXY: turn on the vertical axis first, then lean back toward the camera's
    # horizon, so the turned tile's sides stay upright on screen instead of rolling.
    pivot.rotation_mode = "ZXY"
    pivot.rotation_euler = (math.radians(PITCH0 + (PITCH1 - PITCH0) * t), 0, math.radians(YAW0 + (YAW1 - YAW0) * t))


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    a = parse_args()
    global FONT
    FONT = a.font
    if not os.path.exists(FONT):
        raise SystemExit(f"font not found: {FONT}")
    os.makedirs(a.out, exist_ok=True)
    reset()
    device = use_device(a.cpu)
    gpu = device != "CPU"
    dark = a.mode == "front-dark"
    pivot = build_icon()
    studio(dark)

    if a.mode in ("frames", "still"):
        floor()
        camera(85, *CAM_FRAMES)
        setup_render(a.res, a.res, a.samples or (256 if a.mode == "still" else 128) if gpu else (a.samples or 48), device)
        if a.mode == "still":
            pose(pivot, 0)
            render_to(os.path.join(a.out, "still.png"))
        else:
            for i in range(a.frames):
                pose(pivot, i / (a.frames - 1))
                render_to(os.path.join(a.out, f"f-{i:03d}.png"))
    elif a.mode in ("front", "front-dark"):
        camera(85, (0, -2.75, 0.0), (0, 0, 0))
        # nearly square on, leaning back a touch so the bottom bowl stays the heavier one
        pivot.rotation_mode = "ZXY"
        pivot.rotation_euler = (math.radians(-5), 0, math.radians(-6))
        setup_render(512, 512, a.samples or (256 if gpu else 64), device)
        render_to(os.path.join(a.out, "front-dark.png" if dark else "front.png"))
    elif a.mode == "og":
        floor()
        # a 1200x630 frame has a much shorter vertical field, so the camera sits further back
        camera(85, (0, -8.4, 2.95), (0, 0, -0.1))
        pose(pivot, 0)
        setup_render(1200, 630, a.samples or (256 if gpu else 64), device)
        render_to(os.path.join(a.out, "og.png"))


main()
