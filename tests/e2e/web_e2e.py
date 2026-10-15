"""E2E of the generated app in a real browser. Run: npm run build && npx fluxplugin start --web (port 5360), then python3 tests/e2e/web_e2e.py"""
from playwright.sync_api import sync_playwright, expect
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1180,"height":780}); errs=[]
    pg.on("pageerror",lambda e:errs.append(str(e))); pg.on("console",lambda m: m.type=="error" and errs.append(m.text[:200]))
    pg.goto("http://127.0.0.1:5360"); pg.wait_for_selector("[data-testid=nav-dashboard]")
    # shell: fixed sidebar + independently scrolling content
    print("body overflow:", pg.evaluate("getComputedStyle(document.querySelector('.main')).overflowY"), "| sidebar w:", pg.evaluate("document.querySelector('.flux-side').getBoundingClientRect().width"))
    pg.get_by_test_id("sidebar-toggle").click(); pg.wait_for_timeout(350)
    print("collapsed w:", pg.evaluate("document.querySelector('.flux-side').getBoundingClientRect().width"), "| labels:", pg.locator(".flux-nav-label").count())
    pg.get_by_test_id("sidebar-toggle").click(); pg.wait_for_timeout(300)
    # settings: language + appearance
    pg.get_by_test_id("nav-settings").click(); pg.wait_for_selector("[data-testid=settings-page]")
    pg.get_by_test_id("settings-language").click(); pg.get_by_test_id("lang-fr").click()
    expect(pg.get_by_test_id("nav-dashboard")).to_contain_text("Tableau de bord"); expect(pg.get_by_test_id("nav-settings")).to_contain_text("Réglages")
    print("lang attr:", pg.evaluate("document.documentElement.lang"))
    pg.get_by_test_id("settings-appearance").click(); pg.wait_for_selector("[data-testid=font-select]")
    pg.select_option("[data-testid=font-select]","serif"); pg.fill("[data-testid=custom-font]","Avenir Next"); pg.keyboard.press("Enter")
    pg.get_by_test_id("accent-ff375f").click(); pg.get_by_test_id("theme-midnight").click()
    print("font var:", pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--flux-font')")[:60], "| theme:", pg.evaluate("document.documentElement.dataset.theme"), "| accent:", pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--flux-accent')"))
    pg.locator("[data-testid=font-size]").fill("18"); print("font-size var:", pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--flux-font-size')"))
    pg.screenshot(path="/home/claude/flux/docs/screenshots/settings-appearance.png")
    pg.get_by_test_id("lang-fr").count()
    pg.get_by_test_id("settings-language").click(); pg.get_by_test_id("lang-en").click()
    # plugin manager → details screen (new screen with navigation)
    pg.get_by_test_id("nav-plugins").click(); pg.wait_for_selector("[data-testid=plugins-page]")
    pg.get_by_test_id("row-com.example.hello").click(); pg.wait_for_selector("[data-testid=plugin-details]")
    print("hash:", pg.evaluate("location.hash"), "| readme:", pg.get_by_test_id("plugin-readme").inner_text()[:40].replace("\n"," "))
    print("table rendered:", pg.locator(".flux-md table").count(), "| perms rows:", pg.locator("[data-testid=plugin-details] .flux-row").count())
    pg.screenshot(path="/home/claude/flux/docs/screenshots/plugin-page.png")
    pg.get_by_test_id("plugin-back").click(); pg.wait_for_selector("[data-testid=plugins-page]"); print("back hash:", pg.evaluate("location.hash"))
    print("page errors:", errs[:4])
    b.close()
print("V2 UI OK")
