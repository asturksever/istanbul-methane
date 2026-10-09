#!/usr/bin/env python3
"""Headless renderer: serves web/, drives the page frame by frame with Playwright,
pipes PNG frames into ffmpeg.

  GOOGLE_MAPS_API_KEY=... python3 render.py                 # full video -> out/istanbul-methane.mp4
  python3 render.py --stills 3,16,24,36,45,60               # PNG stills at those seconds -> out/
  python3 render.py --start 0 --end 5                       # seconds range
Options: --fps 30 --w 1920 --h 1080 --sse 6 --steps 80 --look ember|turbo|smoke --debug
"""
import argparse, http.server, os, pathlib, socketserver, subprocess, sys, threading, time, functools, json

ROOT = pathlib.Path(__file__).resolve().parent
WEB = ROOT / "web"
OUT = ROOT / "out"

ap = argparse.ArgumentParser()
ap.add_argument("--stills", default="")
ap.add_argument("--start", type=float, default=0)
ap.add_argument("--end", type=float, default=None)
ap.add_argument("--fps", type=int, default=30)
ap.add_argument("--w", type=int, default=1920)
ap.add_argument("--h", type=int, default=1080)
ap.add_argument("--sse", type=float, default=8)
ap.add_argument("--steps", type=int, default=80)
ap.add_argument("--look", default="ember")
ap.add_argument("--debug", type=int, default=0)
ap.add_argument("--out", default="istanbul-methane.mp4")
ap.add_argument("--key", default=os.environ.get("GOOGLE_MAPS_API_KEY", ""))
ap.add_argument("--crf", type=int, default=16)
ap.add_argument("--maxiter", type=int, default=400)
ap.add_argument("--bench", action="store_true")
ap.add_argument("--seglen", type=int, default=270)
ap.add_argument("--volscale", type=float, default=0.5)
ap.add_argument("--ws", default="")
args = ap.parse_args()
OUT.mkdir(exist_ok=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(Quiet, directory=str(WEB))
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def main():
    from playwright.sync_api import sync_playwright
    port = serve()
    qs = f"mode=render&fps={args.fps}&sse={args.sse}&steps={args.steps}&volscale={args.volscale}&look={args.look}" + (f"&debug={args.debug}" if args.debug else "") + (f"&ws={args.ws}" if args.ws else "") + (f"&key={args.key}" if args.key else "")
    url = f"http://127.0.0.1:{port}/index.html?{qs}"
    print("mode:", "google 3d tiles" if args.key else "open map (no key)", flush=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=[
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
            "--enable-webgl", "--disable-gpu-vsync", "--js-flags=--max-old-space-size=6144", "--disable-dev-shm-usage",
            "--font-render-hinting=none", "--hide-scrollbars", f"--window-size={args.w},{args.h}"])
        ctx = browser.new_context(viewport={"width": args.w, "height": args.h}, device_scale_factor=1)
        page = ctx.new_page()
        errors = []
        def on_console(m):
            if m.type in ("error", "warning") or m.text.startswith("terrain"):
                print("  [console]", m.type, m.text[:400].replace("\n", " | "), flush=True)
            if "compile log" in m.text or "Rendering has stopped" in m.text:
                print("FATAL: shader/render error, aborting", flush=True); os._exit(3)
        page.on("console", on_console)
        page.on("requestfailed", lambda rq: print("  [reqfail]", rq.url[:200], flush=True))
        page.on("response", lambda rs: (print("  [http]", rs.status, rs.url[:200], flush=True) if rs.status >= 400 else None))
        page.on("pageerror", lambda e: (errors.append(str(e)), print("  [pageerror]", str(e)[:500], flush=True)))
        page.goto(url, wait_until="load", timeout=120000)
        t0 = time.time()
        page.wait_for_function("() => window.__ready !== undefined || !!window.__fatal || document.getElementById('bootError').style.display === 'flex'", timeout=180000)
        try:
            page.evaluate("async () => { await window.__ready; window.__readyDone = true; }")
        except Exception as e:
            fatal = page.evaluate("() => window.__fatal || null")
            print("FATAL:", fatal or str(e)[:400], flush=True); browser.close(); sys.exit(2)
        if args.bench:
            page.evaluate("() => window.__time(22)")
            for skip in (1, 0):
                page.evaluate(f"() => {{ window.__forceSkip = {skip}; }}")
                t1 = time.time(); page.evaluate("() => window.__frame(660, 0)"); t2 = time.time(); page.screenshot(type="png", timeout=300000); t3 = time.time()
                print(f"bench skip={skip}: frame {t2-t1:.2f}s  screenshot {t3-t2:.2f}s", flush=True)
            browser.close(); return
        total = page.evaluate("() => window.__total")
        print(f"ready in {time.time()-t0:.1f}s, timeline {total}s", flush=True)

        if args.stills:
            for ts in [float(x) for x in args.stills.split(",")]:
                t1 = time.time()
                r = page.evaluate(f"() => window.__time({ts})")
                fn = OUT / f"still_{ts:05.1f}s.png"
                page.screenshot(path=str(fn), type="png", timeout=300000)
                print(f"still t={ts:5.1f}s  {time.time()-t1:5.1f}s  {json.dumps(r)}", flush=True)
            browser.close(); return

        start_f = int(round(args.start * args.fps)); end_f = int(round((args.end if args.end is not None else total) * args.fps))
        outp = OUT / args.out
        # Resumable: frames are written in fixed-length segments; a segment with a .done marker is skipped on restart.
        segdir = OUT / (pathlib.Path(args.out).stem + "_segments"); segdir.mkdir(exist_ok=True)
        seglen = args.seglen
        enc = ["-c:v", "libx264", "-preset", "slow", "-crf", str(args.crf), "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "5.1"]
        tstart = time.time(); slow = 0; rendered = 0
        segs = [(s0, min(s0 + seglen, end_f)) for s0 in range(start_f, end_f, seglen)]
        todo = [sg for sg in segs if not (segdir / f"seg_{sg[0]:06d}.done").exists()]
        print(f"segments: {len(segs)} total, {len(segs) - len(todo)} already done, {len(todo)} to render", flush=True)
        for s0, s1 in todo:
            segf = segdir / f"seg_{s0:06d}.mp4"
            ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(args.fps), "-c:v", "png", "-i", "-"] + enc + [str(segf)], stdin=subprocess.PIPE)
            for i in range(s0, s1):
                t1 = time.time()
                r = page.evaluate(f"() => window.__frame({i}, {args.maxiter})")
                png = page.screenshot(type="png", timeout=300000)
                ff.stdin.write(png); rendered += 1
                dt = time.time() - t1
                if not r["loaded"]:
                    slow += 1
                if i % 30 == 0 or not r["loaded"]:
                    el = time.time() - tstart; left = sum(b - a for a, b in todo) - rendered; eta = left * el / rendered
                    print(f"frame {i:5d}/{end_f}  t={r['t']:6.2f}s  {dt:5.1f}s/frame  iters={r['iters']:3d} loaded={r['loaded']}  eta {eta/60:5.1f} min  {json.dumps(r['stats'])}", flush=True)
                if i % 450 == 0:
                    (OUT / "preview").mkdir(exist_ok=True)
                    (OUT / "preview" / f"f{i:05d}.png").write_bytes(png)
            ff.stdin.close(); ff.wait()
            (segdir / f"seg_{s0:06d}.done").write_text(str(s1))
            print(f"segment {s0}-{s1} done", flush=True)
        lst = segdir / "concat.txt"
        lst.write_text("".join(f"file '{segdir / f'seg_{s0:06d}.mp4'}'\n" for s0, _ in segs))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(outp)], check=True)
        print(f"done: {outp} ({outp.stat().st_size/1e6:.1f} MB), {end_f-start_f} frames, {rendered} rendered this run in {(time.time()-tstart)/60:.1f} min, incomplete-tile frames: {slow}", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
