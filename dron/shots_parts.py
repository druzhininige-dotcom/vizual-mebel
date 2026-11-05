"""Точечные скриншоты правок: секции по селекторам, мобильные программы, 4 темы."""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
HTML = ROOT / "Дрон-Победы-сайт.html"
OUT = ROOT / "deploy_v2" / "parts"
OUT.mkdir(parents=True, exist_ok=True)

SHOTS = [("#prod", "prod"), (".progs", "progs"), (".hero-in", "hero"), (".lesson", "lesson"), (".cta", "cta")]

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(HTML.as_uri()); pg.wait_for_timeout(1200)
    pg.evaluate("""async () => { for (let y=0; y<document.body.scrollHeight; y+=500){ window.scrollTo(0,y); await new Promise(r=>setTimeout(r,90)); } window.scrollTo(0,0); }""")
    pg.wait_for_timeout(1200)
    for sel, name in SHOTS:
        el = pg.query_selector(sel)
        if el:
            el.screenshot(path=str(OUT / f"d_{name}.png"))
    # мобильные программы
    m = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    m.goto(HTML.as_uri()); m.wait_for_timeout(800)
    m.evaluate("""async () => { for (let y=0; y<document.body.scrollHeight; y+=500){ window.scrollTo(0,y); await new Promise(r=>setTimeout(r,80)); } }""")
    m.wait_for_timeout(800)
    for sel, name in [(".progs", "m_progs"), ("#prod", "m_prod"), (".hero-in", "m_hero")]:
        el = m.query_selector(sel)
        if el:
            el.screenshot(path=str(OUT / f"{name}.png"))
    # 4 темы: hero + prod
    t = b.new_page(viewport={"width": 1280, "height": 820})
    t.goto(HTML.as_uri()); t.wait_for_timeout(800)
    for th in ["a", "b", "b1", "b2"]:
        t.evaluate(f"document.documentElement.setAttribute('data-theme','{th}'); window.scrollTo(0,0)")
        t.wait_for_timeout(400)
        t.screenshot(path=str(OUT / f"t_{th}_hero.png"))
        t.evaluate("document.querySelector('#prod').scrollIntoView()")
        t.wait_for_timeout(500)
        t.screenshot(path=str(OUT / f"t_{th}_prod.png"))
    b.close()
print("готово:", sorted(x.name for x in OUT.iterdir()))
