/* СЦЕНА 3D (three.js r160, локальный файл с сервера).
 *
 * В этом файле НЕТ размеров мебели: он только рисует то, что пришло с сервера
 * (детали в мм из построить.py). Текстуры генерируются на canvas — ни одного
 * мегабайта картинок, ни одного внешнего запроса.
 */
export const ВЕРСИЯ_СЦЕНЫ = "3d-bug7-6";

export function создатьСцену(хост, THREE, OrbitControls, настройки = {}) {
  console.log("[k3d] сцена " + ВЕРСИЯ_СЦЕНЫ + " запущена");
  const рендерер = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  рендерер.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  рендерер.shadowMap.enabled = true;
  рендерер.shadowMap.type = THREE.PCFSoftShadowMap;
  рендерер.outputColorSpace = THREE.SRGBColorSpace;
  рендерер.toneMapping = THREE.ACESFilmicToneMapping;
  рендерер.toneMappingExposure = 1.05;
  рендерер.domElement.style.display = "block";
  рендерер.domElement.style.width = "100%";
  рендерер.domElement.style.height = "100%";
  рендерер.domElement.setAttribute("aria-label", "3D-конструктор кухни");
  хост.appendChild(рендерер.domElement);

  const сцена = new THREE.Scene();
  // светлая комната: графитовые фасады читаются только на светлом фоне
  сцена.background = new THREE.Color(0xeceae4);
  сцена.fog = new THREE.Fog(0xeceae4, 16, 40);

  const камера = new THREE.PerspectiveCamera(40, 1, 0.05, 80);
  const управление = new OrbitControls(камера, рендерер.domElement);
  управление.enableDamping = true;
  управление.dampingFactor = 0.075;
  управление.rotateSpeed = 0.85;
  управление.zoomSpeed = 0.85;
  управление.panSpeed = 0.7;
  управление.maxPolarAngle = Math.PI * 0.495;
  управление.minPolarAngle = 0.05;
  управление.screenSpacePanning = false;
  управление.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  /* ── ЗУМ: свой плавный обработчик ───────────────────────────────────────
     Почему не родной зум OrbitControls. В three r160 (vendor/OrbitControls.r160.js)
     getZoomScale() считает:
         normalized_delta = |delta| / (100 * (window.devicePixelRatio | 0));
     Если масштаб браузера меньше 100 % (или страница в iframe с зумом), то
     devicePixelRatio < 1, `| 0` даёт 0, деление на ноль → Math.pow(0.95, Infinity) = 0
     → dollyIn(0) → радиус × 0 → кламп на minDistance.
     Замер 31.10.2026 (тесты/_диагностика_зума.py): при dpr 1.0 зум идёт по 4,3 %,
     при dpr 0.9 ОДИН щелчок колеса схлопывает дистанцию 5.413 → 0.600 м. Отсюда
     «только два положения: общий вид или вплотную к варочной панели».
     Лечение: колесо обрабатываем сами (8 % за шаг, порог 100 px для тачпада),
     родной зум остаётся только для pinch (два пальца), а его формула в vendor
     исправлена на Math.max(1, devicePixelRatio).                                  */
  const ШАГ_ЗУМА = 0.08;          // 8 % дистанции за «нотку» колеса (ТЗ: 5–10 %)
  const ПОРОГ_КОЛЕСА = 100;       // px на один шаг: одна нотка колеса = 100 px = 8 %;
                                  // тачпад шлёт мелкие дельты — они копятся до порога
  const МАКС_ШАГОВ = 1;           // один шаг за событие: 8 %, всегда внутри 5–10 %
  const МИН_ДО_МОДУЛЕЙ = 0.8;     // м: камера не ближе 0,8 м к поверхности модулей

  /* ── ЕДИНОЕ правило поворота по стене (общее правило ТЗ 4) ──────────────
     ЗАД = 0°, ЛЕВ = −90°, ПРАВ = +90°. Знак выбран так, чтобы локальный +Z
     любой детали прибора всегда смотрел В СТЕНУ: у задней стены это +Z мира,
     у левой −X, у правой +X. Все типы модулей и приборов обязаны брать угол
     только отсюда — никаких своих «Math.PI / 2» по месту. */
  function поворотПоСтене(плечо) {
    const п = плечо || "задняя";
    if (п === "левая") return -Math.PI / 2;
    if (п === "правая") return Math.PI / 2;
    return 0;
  }
  let накоплениеКолеса = 0;

  function дистанцияДоКухни() {
    return габарит.коробка ? габарит.коробка.distanceToPoint(камера.position) : Infinity;
  }

  /* Камера не заходит внутрь модулей: если до ближайшей поверхности меньше
     0,8 м — отодвигаем её по лучу «цель → камера», пока не станет 0,8 м. */
  function неПускатьВнутрь() {
    const коробка = габарит.коробка;
    if (!коробка) return;
    let д = коробка.distanceToPoint(камера.position);
    if (д >= МИН_ДО_МОДУЛЕЙ) return;
    const напр = камера.position.clone().sub(управление.target);
    const было = напр.length();
    if (было < 1e-6) return;
    напр.divideScalar(было);
    let радиус = было;
    for (let i = 0; i < 80 && д < МИН_ДО_МОДУЛЕЙ; i++) {
      радиус = Math.min(радиус + (МИН_ДО_МОДУЛЕЙ - д) + 0.01, управление.maxDistance);
      камера.position.copy(управление.target).addScaledVector(напр, радиус);
      д = коробка.distanceToPoint(камера.position);
      if (радиус >= управление.maxDistance) break;
    }
  }

  /* Умножить дистанцию камеры до цели на коэффициент (0.92 = приблизить на 8 %). */
  function приблизить(коэф) {
    const напр = камера.position.clone().sub(управление.target);
    const было = напр.length();
    if (!(было > 1e-6)) return;
    напр.divideScalar(было);
    const надо = Math.max(0.05, Math.min(управление.maxDistance, было * коэф));
    камера.position.copy(управление.target).addScaledVector(напр, надо);
    неПускатьВнутрь();
    управление.update();
    отрисоватьСразу(true);
  }

  function наКолесо(е) {
    if (!управление.enabled || !е.deltaY) return;
    // свой зум: событие не должно дойти до родного обработчика OrbitControls
    е.preventDefault();
    е.stopPropagation();
    накоплениеКолеса += Number(е.deltaY) || 0;
    if (Math.abs(накоплениеКолеса) < ПОРОГ_КОЛЕСА) return;
    const шагов = Math.min(МАКС_ШАГОВ, Math.floor(Math.abs(накоплениеКолеса) / ПОРОГ_КОЛЕСА));
    const знак = Math.sign(накоплениеКолеса);
    накоплениеКолеса -= знак * шагов * ПОРОГ_КОЛЕСА;
    приблизить(Math.pow(знак < 0 ? 1 - ШАГ_ЗУМА : 1 + ШАГ_ЗУМА, шагов));
  }
  // capture на контейнере: срабатывает ДО обработчика OrbitControls на canvas,
  // поэтому stopPropagation реально отменяет родной (ломающийся) зум
  хост.addEventListener("wheel", наКолесо, { passive: false, capture: true });
  // поворот/pan/pinch тоже не должны заносить камеру внутрь модулей
  управление.addEventListener("change", () => { неПускатьВнутрь(); });

  /* ── свет ───────────────────────────────────────────────────────────── */
  const небо = new THREE.HemisphereLight(0xffffff, 0xd6d0c5, 1.35);
  сцена.add(небо);
  сцена.add(new THREE.AmbientLight(0xffffff, 0.45));
  const ключ = new THREE.DirectionalLight(0xfffaf2, 2.0);
  ключ.castShadow = true;
  ключ.shadow.mapSize.set(2048, 2048);
  ключ.shadow.bias = -0.0006;
  ключ.shadow.normalBias = 0.02;
  сцена.add(ключ);
  сцена.add(ключ.target);
  const заполняющий = new THREE.DirectionalLight(0xdce8ff, 0.75);
  сцена.add(заполняющий);
  // фронтальный заполняющий: без него тёмные фасады читаются как чёрное пятно
  const фронт = new THREE.DirectionalLight(0xffffff, 0.7);
  фронт.position.set(0, 1.4, -4);
  сцена.add(фронт);
  const тёплый = new THREE.PointLight(0xfff2e2, 7, 9, 2.2);
  тёплый.position.set(1.6, 2.35, 1.2);
  сцена.add(тёплый);

  /* ── комната: пол и стены (не мебель, только масштаб и свет) ─────────── */
  const комната = new THREE.Group();
  сцена.add(комната);

  const пол = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xd9d1c4, roughness: 0.9, metalness: 0 })
  );
  пол.rotation.x = -Math.PI / 2;
  пол.receiveShadow = true;
  комната.add(пол);

  const стена_задняя = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xf3f1ec, roughness: 0.96, side: THREE.DoubleSide })
  );
  комната.add(стена_задняя);

  const стена_бок = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xeeece6, roughness: 0.96, side: THREE.DoubleSide })
  );
  комната.add(стена_бок);

  /* Правая стена — ПОЛУПРОЗРАЧНАЯ (решение владельца 04.11.2026).
     Камера «три четверти» смотрит со стороны +x: сплошная стена закрывала бы
     кухню, поэтому раньше её не рисовали вовсе — и правое плечо висело в
     воздухе. Теперь стена есть, но с opacity 0,12: границу комнаты видно, а
     кухня за ней читается. depthWrite выключен, иначе прозрачность режет
     мебель по глубине. Контур (EdgesGeometry) нужен потому, что одна заливка
     на 12 % почти невидима: рамка показывает, что стена есть. */
  const стена_правая = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xeae7e0, roughness: 0.96,
      side: THREE.DoubleSide, transparent: true, opacity: 0.12, depthWrite: false })
  );
  стена_правая.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
    new THREE.LineBasicMaterial({ color: 0xbfb9ad, transparent: true, opacity: 0.55 })
  ));
  комната.add(стена_правая);

  /* ── материалы и текстуры (canvas, без файлов) ───────────────────────── */
  const текстуры = new Map();
  const материалы = new Map();

  function текстура(вид, цвет) {
    if (!вид || вид === "нет") return null;
    const ключ = вид + "|" + цвет;
    if (текстуры.has(ключ)) return текстуры.get(ключ);
    const к = document.createElement("canvas");
    к.width = 256; к.height = 256;
    const х = к.getContext("2d");
    х.fillStyle = цвет;
    х.fillRect(0, 0, 256, 256);
    if (вид === "дерево") {
      for (let i = 0; i < 220; i++) {
        const y = Math.random() * 256;
        х.strokeStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.07})`;
        х.lineWidth = 0.6 + Math.random() * 2.4;
        х.beginPath();
        х.moveTo(0, y);
        х.bezierCurveTo(64, y + (Math.random() - 0.5) * 7, 160, y + (Math.random() - 0.5) * 9, 256, y + (Math.random() - 0.5) * 6);
        х.stroke();
      }
      for (let i = 0; i < 26; i++) {
        х.strokeStyle = `rgba(255,255,255,${0.03 + Math.random() * 0.05})`;
        х.lineWidth = 1 + Math.random() * 3;
        х.beginPath();
        х.moveTo(0, Math.random() * 256);
        х.lineTo(256, Math.random() * 256);
        х.stroke();
      }
    } else if (вид === "камень") {
      for (let i = 0; i < 2600; i++) {
        const r = Math.random() * 1.7;
        х.fillStyle = `rgba(${Math.random() > 0.5 ? 255 : 0},${Math.random() > 0.5 ? 255 : 0},255,${0.02 + Math.random() * 0.06})`;
        х.beginPath();
        х.arc(Math.random() * 256, Math.random() * 256, r, 0, Math.PI * 2);
        х.fill();
      }
    }
    const т = new THREE.CanvasTexture(к);
    т.colorSpace = THREE.SRGBColorSpace;
    т.wrapS = THREE.RepeatWrapping;
    т.wrapT = THREE.RepeatWrapping;
    т.repeat.set(2, 2);
    т.anisotropy = Math.min(8, рендерер.capabilities.getMaxAnisotropy());
    текстуры.set(ключ, т);
    return т;
  }

  function материал(цвет, вид, прозрачность, шероховатость) {
    const ключ = [цвет, вид, прозрачность, шероховатость].join("|");
    if (материалы.has(ключ)) return материалы.get(ключ);
    const карта = текстура(вид, цвет);
    const м = new THREE.MeshStandardMaterial({
      color: карта ? 0xffffff : new THREE.Color(цвет),
      map: карта,
      roughness: шероховатость,
      metalness: 0.02,
      transparent: прозрачность < 1,
      opacity: прозрачность,
      side: THREE.DoubleSide,
    });
    материалы.set(ключ, м);
    return м;
  }

  /* ── отделка: одна пара материалов на роль ─────────────────────────────
     Фасады и столешница меняют только цвет/текстуру. Держим по одному
     материалу на роль, чтобы смена материала была плавной и без пересборки. */
  const отделка = {
    фасад: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.02, side: THREE.DoubleSide }),
    столешница: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.02, side: THREE.DoubleSide }),
  };
  // шов по створке: без него ряд тумб читается как один растянутый блок.
  // Цвет шва контрастен самому фасаду: светлый на графите, тёмный на белом.
  const шовМатериалы = new Map();
  function шовМатериал(цвет) {
    let яркость = 0.5;
    try {
      const к = new THREE.Color(цвет || "#888888");
      яркость = 0.299 * к.r + 0.587 * к.g + 0.114 * к.b;
    } catch (е) { /* цвет не разобрался — берём светлый шов */ }
    const ключ = яркость > 0.55 ? "тёмный" : "светлый";
    if (!шовМатериалы.has(ключ)) {
      шовМатериалы.set(ключ, new THREE.LineBasicMaterial({
        color: ключ === "тёмный" ? 0x4a5158 : 0xf1efe9,
        transparent: true, opacity: 0.9,
      }));
    }
    return шовМатериалы.get(ключ);
  }
  const шовКорпуса = new THREE.LineBasicMaterial({ color: 0x8a8f94, transparent: true, opacity: 0.16 });
  // контуры створок: при смене фасада их цвет обязан поменяться вместе с ним,
  // иначе на светлом фасаде остаётся светлый шов (и наоборот) — фасад «не сменился»
  let швыФасадов = [];
  function обновитьШвыФасадов() {
    const цвет = (фасадМатериал && фасадМатериал.цвет) || "#888888";
    const мат = шовМатериал(цвет);
    for (const ш of швыФасадов) { ш.material = мат; }
  }

  function анимироватьЦвет(материал, цель, мс = 240) {
    const старт = материал.color.clone();
    const к = new THREE.Color(цель);
    const t0 = performance.now();
    if (материал._анимация) cancelAnimationFrame(материал._анимация);
    const шагКадр = () => {
      const п = Math.min(1, (performance.now() - t0) / мс);
      материал.color.copy(старт).lerp(к, п);
      отрисоватьСразу();
      материал._анимация = п < 1 ? requestAnimationFrame(шагКадр) : null;
    };
    шагКадр();
  }

  function задатьОтделку(роль, цвет, вид, мгновенно) {
    const м = отделка[роль];
    if (!м || !цвет) return;
    const карта = текстура(вид, цвет);
    if (карта) {
      if (м.map !== карта) { м.map = карта; м.needsUpdate = true; }
      м.color.set(0xffffff);
      перерисовать();
      return;
    }
    if (м.map) { м.map = null; м.needsUpdate = true; }
    if (мгновенно) { м.color.set(цвет); перерисовать(); }
    else анимироватьЦвет(м, цвет);
  }

  /* ── мебель ─────────────────────────────────────────────────────────── */
  const кухня = new THREE.Group();
  сцена.add(кухня);
  let группыМодулей = [];
  let добавленные = [];        // техника и столешница: кладутся в сцену мимо модулей
  let меши = [];
  let рамка = null;
  let выделенный = null;
  let данныеСцены = null;
  let фасадМатериал = null;
  let столешницаМатериал = null;
  let габарит = { x: 0, y: 0, z: 0, центр: new THREE.Vector3(), радиус: 1 };
  /* «Показать полки»: корпус становится полупрозрачным, полки остаются видимыми.
     Храним исходный материал каждого меша, чтобы вернуть его обратно. */
  let корпусные = [];              // [{меш, мат}]
  let прозрачныйМатериал = null;
  let полкиВидны = false;

  function материалПрозрачный() {
    if (!прозрачныйМатериал) {
      прозрачныйМатериал = new THREE.MeshStandardMaterial({
        color: 0xdde2e8, transparent: true, opacity: 0.16, roughness: 0.85,
        metalness: 0, depthWrite: false, side: THREE.DoubleSide });
    }
    return прозрачныйМатериал;
  }

  function цветФасада(конфиг, id) {
    const ф = ((конфиг && конфиг.фасады) || []).find((м) => м.id === id);
    return ф ? { цвет: ф.цвет_3д || ф.цвет, вид: ф.текстура || "нет" } : null;
  }
  function цветСтолешницы(конфиг, id) {
    const ст = ((конфиг && конфиг.столешницы) || []).find((м) => м.id === id);
    return ст ? { цвет: ст.цвет_3д || ст.цвет, вид: ст.текстура || "нет" } : null;
  }

  function очиститьМебель() {
    for (const г of группыМодулей) {
      г.traverse((о) => { if (о.geometry) о.geometry.dispose(); });
      кухня.remove(г);
    }
    группыМодулей = [];
    for (const о of добавленные) {
      о.traverse((д) => { if (д.geometry) д.geometry.dispose(); });
      кухня.remove(о);
    }
    добавленные = [];
    меши = [];
    корпусные = [];
    швыФасадов = [];
    if (рамка) { кухня.remove(рамка); рамка.geometry.dispose(); рамка.material.dispose(); рамка = null; }
    выделенный = null;
  }

  /* ── ФАРТУК (ТЗ E) ───────────────────────────────────────────────────────
     Плоскости на стенах между поверхностью столешницы и низом верхних шкафов.
     Участки, высоту и площадь считает ядро (сборка.py::_фартук_json) — сцена
     только рисует, своих чисел не придумывает. Живёт отдельной группой, поэтому
     смена варианта не пересобирает кухню (ТЗ E.3). */
  let фартукГруппа = null;

  function очиститьФартук() {
    if (!фартукГруппа) return;
    кухня.remove(фартукГруппа);
    фартукГруппа.traverse((о) => {
      if (о.geometry) о.geometry.dispose();
      if (о.material && о.material.dispose) о.material.dispose();
    });
    фартукГруппа = null;
  }

  function построитьФартук(ф) {
    очиститьФартук();
    const данные = ф || (данныеСцены && данныеСцены.фартук);
    if (!данные || !(данные.участки || []).length) { перерисовать(); return; }
    // ВАЖНО: Number(null) === 0, из-за этого непрозрачный фартук рисовался с
    // opacity 0 (невидим). Прозрачность применяем только когда она реально число.
    const прозр = данные.прозрачность;
    const полупрозрачный = (typeof прозр === "number") && прозр < 1;
    const мат = new THREE.MeshStandardMaterial({
      color: new THREE.Color(данные.цвет || "#c9c3b6"),
      roughness: (данные.текстура === "стекло") ? 0.08 : 0.82,
      metalness: 0.0,
      transparent: полупрозрачный,
      opacity: полупрозрачный ? прозр : 1,
      side: THREE.DoubleSide,
    });
    const стена_мм = Number(данныеСцены && данныеСцены.длина_мм) || 0;
    const г = new THREE.Group();
    for (const у of данные.участки || []) {
      const ш_м = Math.max(0.01, (Number(у.до) - Number(у.от)) / 1000);
      const в_м = Math.max(0.01, Number(у.высота_мм || (у.верх_мм - у.низ_мм)) / 1000);
      const меш = new THREE.Mesh(new THREE.PlaneGeometry(ш_м, в_м), мат);
      const центрY = ((Number(у.низ_мм) + Number(у.верх_мм)) / 2) / 1000;
      const центрX = (Number(у.от) + Number(у.до)) / 2000;
      if ((у.плечо || "задняя") === "задняя") {
        // задняя стена нарисована на z = 0.02 — фартук ставим ПЕРЕД ней (0.012),
        // иначе плоскость прячется за стеной и фартука не видно
        меш.position.set(центрX, центрY, 0.012);
      } else {
        // боковая стена: по X — глубина комнаты, участок идёт по Z
        меш.position.set((у.плечо === "левая") ? 0.006 : (стена_мм / 1000) - 0.006,
                         центрY, -центрX);
        меш.rotation.y = поворотПоСтене(у.плечо);
      }
      меш.userData = { фартук: true, плечо: у.плечо || "задняя" };
      г.add(меш);
    }
    кухня.add(г);
    фартукГруппа = г;
    перерисовать();
  }

  function построить(данные, конфиг, опции) {
    опции = опции || {};
    // размер холста ДО расчёта кадра: от aspect зависит расстояние «вписать
    // кухню в кадр». Без этого первый вид считался при aspect = 1, а «Сброс
    // вида» потом — при настоящем, и камера уезжала на 30 см (блок D).
    if (typeof размер === "function") размер();
    const продолжение = опции.сохранить && меши.length > 0;
    const камераБыла = продолжение ? камера.position.clone() : null;
    const цельБыла = продолжение ? управление.target.clone() : null;
    очиститьМебель();
    данныеСцены = данные;
    фасадМатериал = цветФасада(конфиг, данные.фасад || (данные.сборка && данные.сборка.фасад));
    столешницаМатериал = цветСтолешницы(конфиг, данные.столешница_id
      || (данные.сборка && данные.сборка.столешница_id));
    задатьОтделку("фасад", фасадМатериал && фасадМатериал.цвет,
                  (фасадМатериал && фасадМатериал.вид) || "нет", !продолжение);
    задатьОтделку("столешница", столешницаМатериал && столешницаМатериал.цвет,
                  (столешницаМатериал && столешницаМатериал.вид) || "нет", !продолжение);
    const коробка = new THREE.Box3();

    for (const м of данные.модули || []) {
      const г = new THREE.Group();
      // Детали приходят в МИРОВЫХ координатах (сервер уже повернул корпус на
      // нужное плечо), поэтому группа модуля стоит в нуле — никаких dx/dz и
      // scale по осям. Раньше поворот считался дважды (сервер + сцена), и крыло
      // угловой уезжало за заднюю стену.
      г.position.set(0, 0, 0);
      // Координаты модуля — в системе ТЗ: X вдоль стены, Y от стены в комнату,
      // Z высота низа от пола (engine/модель/сборка.py::_глубина_от_стены).
      г.userData = { модульId: м.id, тип: м.тип, ряд: м.ряд, ширина: м.ширина,
                     плечо: м.плечо || "задняя", x: м.x, y: м.y, z: м.z,
                     отступ: м.отступ || 0, мир: м.мир || null, высота: м.высота };

      // модуль-тень: места в ряду нет в каталоге — показываем полупрозрачной
      // коробкой, в смете его нет (сервер так и считает)
      if (м.тень) {
        const гл = (м.мир ? Math.abs(м.мир.z1 - м.мир.z0) : 560) / 1000;
        if (гл > 0) {
          const ш = (м.мир ? Math.abs(м.мир.x1 - м.мир.x0) : м.ширина) / 1000;
          const тень = new THREE.Mesh(
            new THREE.BoxGeometry(ш, (м.высота || 720) / 1000, гл),
            new THREE.MeshStandardMaterial({ color: 0x9aa4ab, transparent: true, opacity: 0.18,
              roughness: 0.9, metalness: 0, side: THREE.DoubleSide }));
          const x0 = (м.мир ? м.мир.x0 : м.x) / 1000;
          const z0 = (м.мир ? м.мир.z0 : -560) / 1000;
          тень.position.set(x0 + ш / 2, (Number(м.z || 0) + (м.высота || 720) / 2) / 1000, z0 + гл / 2);
          г.add(тень);
          кухня.add(г);
          группыМодулей.push(г);
        }
        continue;
      }

      for (const часть of м.части || []) {
        const частьГруппа = new THREE.Group();
        частьГруппа.position.set((часть.dx || 0) / 1000, 0, (часть.dz || 0) / 1000);
        частьГруппа.rotation.y = ((часть.поворот_y || 0) * Math.PI) / 180;
        for (const д of часть.детали || []) {
          if (!д.д || !д.ш || !д.т) continue;
          const что = String(д.тип || "");
          let цв = д.цвет, вид = "нет", шер = 0.8, роль = null;
          if (что.startsWith("фасад") && фасадМатериал) {
            роль = "фасад";
          } else if (что === "столешница" && столешницаМатериал) {
            роль = "столешница";
          }
          const гео = new THREE.BoxGeometry(д.д / 1000, д.ш / 1000, д.т / 1000);
          const меш = new THREE.Mesh(гео, роль ? отделка[роль] : материал(цв, вид, д.прозрачность ?? 1, шер));
          меш.position.set(
            д.x / 1000 + д.д / 2000,
            д.y / 1000 + д.ш / 2000,
            д.z / 1000 + д.т / 2000,
          );
          меш.castShadow = д.прозрачность >= 1;
          меш.receiveShadow = true;
          меш.userData = { модульId: м.id, деталь: д.id, тип: д.тип, роль };
          // полка — деталь наполнения: её видно в режиме «показать полки»
          if (д.тип === "полка") меш.userData.полка = true;
          else корпусные.push({ меш, мат: меш.material });
          if (роль === "фасад") {
            // контур створки: показывает границы модулей при любой длине
            const шов = new THREE.LineSegments(new THREE.EdgesGeometry(гео),
              шовМатериал((фасадМатериал && фасадМатериал.цвет) || д.цвет));
            швыФасадов.push(шов);
            меш.add(шов);
          } else {
            // еле заметный контур корпуса: границы каждого модуля
            меш.add(new THREE.LineSegments(new THREE.EdgesGeometry(гео), шовКорпуса));
          }
          частьГруппа.add(меш);
          меши.push(меш);
          коробка.expandByObject(меш);
        }
        г.add(частьГруппа);
      }
      кухня.add(г);
      группыМодулей.push(г);
    }

    /* техника: габариты из правила.py, позиции — мировые с сервера.
       ЕДИНОЕ ПРАВИЛО ПОВОРОТА ПО СТЕНЕ (общее правило ТЗ 4): ЗАД = 0°,
       ЛЕВ = −90°, ПРАВ = +90°. Все типы приборов используют одну функцию —
       больше нет ветки «поворот +90° для любого бокового плеча», из-за которой
       правое плечо было зеркальным, а смеситель уезжал от стены.

       Локальные оси прибора: X — ширина вдоль фасада, Y — вверх,
       Z — от фасада К СТЕНЕ (поэтому смеситель и ручки «со стороны стены»
       стоят при +Z, а ручки двери — при −Z). Знак поворота выбран так, чтобы
       локальный +Z всегда смотрел в свою стену: у задней это +Z мира,
       у левой −X, у правой +X. */
    for (const т of данные.техника || []) {
      const плечо = т.плечо || "задняя";
      const ш = Number(т.ширина) || 0;
      const гл = Number(т.глубина) || 0;
      if (!ш || !гл) continue;
      const г = new THREE.Group();
      const М = т.мир || null;
      const x0 = М ? Number(М.x0) || 0 : (Number(т.x) || 0);
      const x1 = М ? Number(М.x1) || (x0 + ш) : (x0 + ш);
      const z0 = М ? Number(М.z0) || 0 : -(Number(т.y) || 0) - гл;
      const z1 = М ? Number(М.z1) || (z0 + гл) : (z0 + гл);
      г.position.set((x0 + x1) / 2000, 0, (z0 + z1) / 2000);
      г.rotation.y = поворотПоСтене(плечо);
      const доб = (мш, lx, ly, lz) => { мш.position.set(lx / 1000, ly / 1000, lz / 1000); г.add(мш); return мш; };
      const тёмный = new THREE.MeshStandardMaterial({ color: 0x191b1e, roughness: 0.28, metalness: 0.55 });
      if (т.id === "hob") {
        доб(new THREE.Mesh(new THREE.BoxGeometry(ш / 1000, т.высота / 1000, гл / 1000), тёмный),
            0, т.z + т.высота / 2, 0);
        for (const [dx, dz] of [[0.25, 0.3], [0.75, 0.3], [0.25, 0.72], [0.75, 0.72]]) {
          const кольцо = new THREE.Mesh(
            new THREE.TorusGeometry(Math.min(ш, гл) / 1000 * 0.11, 0.004, 8, 28),
            new THREE.MeshStandardMaterial({ color: 0x777d84, roughness: 0.35, metalness: 0.7 }));
          кольцо.rotation.x = -Math.PI / 2;
          доб(кольцо, (dx - 0.5) * ш, т.z + т.высота + 2, (dz - 0.5) * гл);
        }
      } else if (т.id === "pmm") {
        // панель ПММ: тёмный металл на ПЕРЕДНЕЙ плоскости.
        // Передняя плоскость в локальных осях — это −Z (−гл/2), а не центр:
        // панель стояла в середине корпуса и её не было видно.
        доб(new THREE.Mesh(new THREE.BoxGeometry(ш / 1000, т.высота / 1000, 0.02),
            new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.35, metalness: 0.65 })),
            0, т.z + т.высота / 2, -гл / 2 + 10);
        доб(new THREE.Mesh(new THREE.BoxGeometry(ш * 0.7 / 1000, 0.02, 0.025),
            new THREE.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.3, metalness: 0.8 })),
            0, т.z + т.высота * 0.9, -гл / 2 - 20);
      } else if (т.id === "fridge") {
        доб(new THREE.Mesh(new THREE.BoxGeometry(ш / 1000, т.высота / 1000, гл / 1000),
            new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.32, metalness: 0.6 })),
            0, т.z + т.высота / 2, 0);
        for (const доля of [0.66, 0.30]) {
          доб(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.32, 0.03),
              new THREE.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.3, metalness: 0.8 })),
              -ш / 2 + 70, т.z + т.высота * доля, -гл / 2 - 4);
        }
      } else if (т.id === "sink") {
        доб(new THREE.Mesh(new THREE.BoxGeometry(ш / 1000, Math.max(т.высота, 8) / 1000, гл / 1000),
            new THREE.MeshStandardMaterial({ color: 0xb9bec5, roughness: 0.28, metalness: 0.75 })),
            0, т.z + Math.max(т.высота, 8) / 2, 0);
        доб(new THREE.Mesh(new THREE.BoxGeometry(ш * 0.78 / 1000, 0.16, гл * 0.7 / 1000),
            new THREE.MeshStandardMaterial({ color: 0x6a7078, roughness: 0.2, metalness: 0.85 })),
            0, т.z - 60, 0);
      } else if (т.id === "faucet") {
        // Смеситель ВСЕГДА у стены (позади чаши). В локальных осях стена —
        // это +Z (+гл/2). Раньше стояло −гл/2, то есть смеситель оказывался
        // перед чашей: на задней стене — у переднего торца, на правой —
        // зеркально сбоку (симптом блока A). Излив смотрит в комнату (−Z).
        const у_стены = гл / 2 - 40;
        доб(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, т.высота / 1000, 16),
            new THREE.MeshStandardMaterial({ color: 0xd7dbe0, roughness: 0.22, metalness: 0.9 })),
            0, т.z + т.высота / 2, у_стены);
        доб(new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.024, 0.19),
            new THREE.MeshStandardMaterial({ color: 0xd7dbe0, roughness: 0.22, metalness: 0.9 })),
            0, т.z + т.высота - 10, у_стены - 0.095 * 1000);
      } else {
        доб(new THREE.Mesh(new THREE.BoxGeometry(ш / 1000, т.высота / 1000, гл / 1000),
            new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.22, metalness: 0.6 })),
            0, т.z + т.высота / 2, 0);
        доб(new THREE.Mesh(new THREE.BoxGeometry(ш * 0.82 / 1000, т.высота * 0.62 / 1000, 0.01),
            new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.12, metalness: 0.4 })),
            0, т.z + т.высота * 0.52, -гл / 2 - 6);
        доб(new THREE.Mesh(new THREE.BoxGeometry(ш * 0.7 / 1000, 0.018, 0.03),
            new THREE.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.3, metalness: 0.8 })),
            0, т.z + т.высота * 0.86, -гл / 2 - 28);
      }
      г.userData = { техника: т.id, модульId: т.модуль || null };
      кухня.add(г);
      добавленные.push(г);
      коробка.expandByObject(г);
    }

    /* столешница: ядро отдаёт ОДНУ сплошную Г-образную плиту (контур в мире X/Z).
         Отдельные плиты-сегменты — запасной путь для старого ответа сервера. */
    const ст = данные.столешница;
    if (!меши.some((м) => м.userData.тип === "столешница")) {
      const плиты = (Array.isArray(данные.столешницы) && данные.столешницы.length)
        ? данные.столешницы
        : (ст && ст.есть ? [ст] : []);
      const матСтол = () => (столешницаМатериал ? отделка["столешница"]
        : материал((ст && ст.цвет) || "#c9b9a3", "нет", 1, 0.32));
      const г_пл = данные.столешница_г;
      if (г_пл && Array.isArray(г_пл.контур) && г_пл.контур.length >= 4) {
        // Г-образная плита одной деталью: контур (X, Z мира) → форма в плоскости
        // XY, выдавливаем на толщину и ставим на высоту столешницы.
        // Мир (X, Z) → форма (x, −z): ось Z смотрит на зрителя, зеркало меняет
        // обход контура, поэтому точки идут в обратном порядке.
        const точки = г_пл.контур.slice().reverse();
        const форма = new THREE.Shape();
        форма.moveTo(точки[0][0] / 1000, -точки[0][1] / 1000);
        for (let i = 1; i < точки.length; i++) {
          форма.lineTo(точки[i][0] / 1000, -точки[i][1] / 1000);
        }
        форма.closePath();
        const гео = new THREE.ExtrudeGeometry(форма,
          { depth: (Number(г_пл.толщина) || 38) / 1000, bevelEnabled: false });
        const мш = new THREE.Mesh(гео, матСтол());
        мш.rotation.x = -Math.PI / 2;
        мш.position.y = (Number(г_пл.y) || 850) / 1000;
        мш.castShadow = true; мш.receiveShadow = true;
        мш.userData = { деталь: "столешница_г", тип: "столешница",
                        роль: столешницаМатериал ? "столешница" : null };
        кухня.add(мш);
        добавленные.push(мш);
        меши.push(мш);
        коробка.expandByObject(мш);
      } else {
        for (const п of плиты) {
          if (!п.ширина || !п.глубина) continue;
          const гео = new THREE.BoxGeometry(п.ширина / 1000, п.толщина / 1000, п.глубина / 1000);
          const мш = new THREE.Mesh(гео, матСтол());
          // z плиты — мировая координата (отрицательная в комнату). Раньше она
          // терялась, и вся столешница уезжала ЗА заднюю стену (баг 3d-bug7 №4).
          мш.position.set((Number(п.x) || 0) / 1000 + п.ширина / 2000,
                          (п.y + п.толщина / 2) / 1000,
                          (Number(п.z) || 0) / 1000 + п.глубина / 2000);
          мш.castShadow = true; мш.receiveShadow = true;
          мш.userData = { деталь: "столешница.1", тип: "столешница",
                          роль: столешницаМатериал ? "столешница" : null };
          кухня.add(мш);
          добавленные.push(мш);
          меши.push(мш);
          коробка.expandByObject(мш);
        }
      }
    }

    /* ── пустые проёмы между модулями: цветной блок «свободно N мм» ───────
       Считаем по каждому ряду и плечу: от стены до первого модуля, между
       модулями и от последнего до стены. Проём меньше 20 мм не показываем —
       это стык, а не дырка. */
    const проёмы = [];
    (function пустыеПроёмы() {
      const стена = Number(данные.длина_мм) || 0;
      const группы = new Map();
      for (const м of данные.модули || []) {
        if (м.тень) continue;
        const ключ = (м.ряд || "низ") + "|" + (м.плечо || "задняя");
        if (!группы.has(ключ)) группы.set(ключ, []);
        группы.get(ключ).push(м);
      }
      for (const [ключ, список] of группы) {
        const [ряд, плечо] = ключ.split("|");
        список.sort((а, б) => а.x - б.x);
        // Боковая ветка Г-образной: за её пределами стены не меряем — углового
        // модуля крыло и конец ветки не «проём». Иначе на боковом плече
        // рисовались ложные блоки «свободно 900» у угла и «свободно 1500» на
        // конце (жалоба «ветки не примыкают, дыры у угла»).
        const боковое = плечо !== "задняя";
        const концы = [];
        if (!боковое) концы.push([0, 0]);
        for (const м of список) концы.push([м.x, м.x + м.ширина]);
        if (!боковое) концы.push([стена, стена]);
        for (let i = 0; i < концы.length - 1; i++) {
          const нач = концы[i][1], кон = концы[i + 1][0];
          const шир = кон - нач;
          if (шир < 20) continue;
          const метка = `свободно ${Math.round(шир)} мм`;
          проёмы.push({ряд, плечо, нач, кон, шир, метка});
        }
      }
    })();

    function подпись3д(текст) {
      const к = document.createElement("canvas");
      к.width = 512; к.height = 128;
      const х = к.getContext("2d");
      х.fillStyle = "rgba(255,148,26,0.92)";
      х.roundRect ? х.roundRect(4, 4, 504, 120, 18) : х.fillRect(4, 4, 504, 120);
      х.fill();
      х.fillStyle = "#21170a";
      х.font = "bold 52px system-ui, sans-serif";
      х.textAlign = "center"; х.textBaseline = "middle";
      х.fillText(текст, 256, 66);
      const т = new THREE.CanvasTexture(к);
      т.anisotropy = 4;
      const с = new THREE.Sprite(new THREE.SpriteMaterial({map: т, transparent: true, depthTest: false}));
      с.scale.set(0.62, 0.155, 1);
      return с;
    }

    for (const п of проёмы) {
      const глуб = п.ряд === "верх" ? 300 : 560;
      const выс = п.ряд === "верх" ? 720 : 850;
      const низ = п.ряд === "верх" ? 1438 : 0;
      const гео = new THREE.BoxGeometry(
        (п.плечо === "задняя" ? п.шир : глуб) / 1000,
        выс / 1000, (п.плечо === "задняя" ? глуб : п.шир) / 1000);
      const мат = new THREE.MeshStandardMaterial({
        color: 0xf2a33c, transparent: true, opacity: 0.22, roughness: 0.9,
        metalness: 0, depthWrite: false, side: THREE.DoubleSide });
      const блок = new THREE.Mesh(гео, мат);
      const середина = (п.нач + п.кон) / 2;
      if (п.плечо === "задняя") блок.position.set(середина / 1000, (низ + выс / 2) / 1000, -глуб / 2000);
      else if (п.плечо === "левая") блок.position.set(глуб / 2000, (низ + выс / 2) / 1000, -середина / 1000);
      else блок.position.set((Number(данные.длина_мм) || 0) / 1000 - глуб / 2000,
                             (низ + выс / 2) / 1000, -середина / 1000);
      блок.userData = {свободно: п.шир, ряд: п.ряд, плечо: п.плечо};
      кухня.add(блок);
      добавленные.push(блок);
      const подп = подпись3д(п.метка);
      подп.position.set(блок.position.x, Math.min(2.35, (низ + выс) / 1000 + 0.12), блок.position.z);
      подп.userData = {подписьПроёма: true};
      кухня.add(подп);
      добавленные.push(подп);
    }

    /* комната подстраивается под габарит */
    if (меши.length) {
      const коробкаКухни = new THREE.Box3().setFromObject(кухня);
      const разм = new THREE.Vector3();
      коробкаКухни.getSize(разм);
      const ш = Math.max(разм.x, 1), в = Math.max(разм.y, 1), гл = Math.max(разм.z, 1);
      габарит = {
        x: ш, y: в, z: гл,
        коробка: коробкаКухни,
        центр: коробкаКухни.getCenter(new THREE.Vector3()),
        радиус: Math.max(ш, в, гл) * 0.75,
      };
      /* Мир: угол комнаты (0,0), задняя стена z = 0, левая x = 0,
         комната — в −z. Поэтому пол и стены стоят со стороны −z. */
      пол.scale.set(Math.max(ш + 6, 8), Math.max(ш + 6, 8), 1);
      пол.position.set(ш / 2, 0, -гл / 2);
      стена_задняя.scale.set(ш + 3, Math.max(в * 1.4, 2.6), 1);
      стена_задняя.position.set(ш / 2, Math.max(в * 1.4, 2.6) / 2, 0.02);
      стена_задняя.rotation.y = Math.PI;
      стена_бок.scale.set(гл + 3, Math.max(в * 1.4, 2.6), 1);
      стена_бок.position.set(-0.02, Math.max(в * 1.4, 2.6) / 2, -гл / 2);
      стена_бок.rotation.y = Math.PI / 2;
      // правая стена: та же геометрия, зеркально у x = ш, полупрозрачная.
      // Ставим её ЗА правым плечом (0.02 м), чтобы фартук и фасады не мерцали
      // в одной плоскости с ней.
      стена_правая.scale.set(гл + 3, Math.max(в * 1.4, 2.6), 1);
      стена_правая.position.set(ш + 0.02, Math.max(в * 1.4, 2.6) / 2, -гл / 2);
      стена_правая.rotation.y = -Math.PI / 2;
      ключ.position.set(ш * 0.35, Math.max(в * 1.35, 2.4), -гл * 1.9);
      ключ.target.position.set(ш / 2, в * 0.45, -гл * 0.3);
      ключ.target.updateMatrixWorld();
      ключ.shadow.camera.left = -ш * 1.2;
      ключ.shadow.camera.right = ш * 1.2;
      ключ.shadow.camera.top = Math.max(в * 1.5, 2.5);
      ключ.shadow.camera.bottom = -Math.max(в * 1.5, 2.5);
      ключ.shadow.camera.near = 0.5;
      ключ.shadow.camera.far = ш * 3 + 8;
      ключ.shadow.camera.updateProjectionMatrix();
      тёплый.position.set(ш * 0.6, Math.max(в * 1.1, 2.2), -гл * 0.9);
      заполняющий.position.set(-ш * 0.6, Math.max(в, 2), -гл * 0.4);
      // minDistance — от ЦЕНТРА кухни; реальную близость к мебели держит
      // неПускатьВнутрь(): 0,8 м до ближайшей поверхности модуля (ТЗ).
      управление.minDistance = 0.8;
      // 4-метровая кухня должна быть видна целиком: maxDistance с запасом
      управление.maxDistance = Math.max(ш * 4, 10);
    }
    // фартук строим ПОСЛЕ расчёта габарита: он не должен раздувать «вписать в кадр»
    построитьФартук(данные.фартук);
    if (продолжение && камераБыла) {
      // ракурс не сбрасываем: сохраняем направление взгляда пользователя,
      // а расстояние подгоняем, только если кухня перестала влезать в кадр
      const направление = камераБыла.clone().sub(цельБыла).normalize();
      const было = камераБыла.distanceTo(цельБыла);
      const надо = расстояниеВписать(направление);
      управление.target.copy(габарит.центр);
      if (надо > было * 1.02) {
        анимироватьКамеру(габарит.центр.clone().add(направление.multiplyScalar(надо)));
      } else {
        камера.position.copy(габарит.центр).add(направление.multiplyScalar(было));
        управление.update();
        отрисоватьСразу();
      }
    } else {
      вид(текущийВид, true);            // первый показ — сразу, без подлёта из ниоткуда
    }
    // «домашний вид» пересчитываем под новый габарит: после добавления модуля
    // или смены формы «Сброс вида» обязан вести в актуальную общую картину
    зафиксироватьДомашний();
    if (текущийВид === "сверху") планПоказать(true);
    // пересборка геометрии (длина, техника) завершается кадром — всегда,
    // даже если блок сейчас считается «вне экрана»
    if (полкиВидны) показатьПолки(true);   // режим не сбрасываем при пересборке
    перерисовать();
  }

  /* ── «показать полки»: корпус прозрачный, полки видны ─────────────────── */
  function показатьПолки(да) {
    полкиВидны = Boolean(да);
    const проз = полкиВидны ? материалПрозрачный() : null;
    for (const { меш, мат } of корпусные) {
      меш.material = проз || мат;
      меш.castShadow = !полкиВидны;
    }
    перерисовать();
  }

  /* ── камера ─────────────────────────────────────────────────────────── */
  let текущийВид = "три_четверти";

  /* ── план сверху: читаемая схема модулей с ширинами в мм ────────────── */
  const планРодитель = хост.parentElement || хост;
  if (getComputedStyle(планРодитель).position === "static") планРодитель.style.position = "relative";
  const планБлок = document.createElement("div");
  планБлок.style.cssText = "position:absolute;inset:0;display:none;background:#f8f7f3;" +
    "padding:60px 18px 16px;box-sizing:border-box;overflow:auto;z-index:3";
  планРодитель.appendChild(планБлок);

  function глубинаМодуля(м) {
    let г = 0;
    for (const ч of м.части || []) {
      for (const д of ч.детали || []) {
        if (String(д.тип || "").startsWith("фасад")) continue;
        г = Math.max(г, Number(д.т) || 0);
      }
    }
    return г;
  }

  function планSVG() {
    const данные = данныеСцены || {};
    const модули = (данные.модули || []).filter((м) => м && м.ширина && м.мир);
    for (const м of модули) м._г = глубинаМодуля(м);
    const низ = модули.filter((м) => String(м.ряд || "").indexOf("верх") < 0);
    const верх = модули.filter((м) => String(м.ряд || "").indexOf("верх") >= 0);

    // область плана — по фактическим модулям плюс запас
    let x0 = 0, x1 = 1000, z0 = -1000, z1 = 0;
    for (const м of модули) {
      x0 = Math.min(x0, м.мир.x0); x1 = Math.max(x1, м.мир.x1);
      z0 = Math.min(z0, м.мир.z0); z1 = Math.max(z1, м.мир.z1);
    }
    x1 = Math.max(x1, Number(данные.длина_мм) || 0, 2400);
    const W = 1000, H = 620, слева = 90, справа = 40, сверху = 64, снизу = 54;
    const k = Math.min((W - слева - справа) / Math.max(x1 - x0, 600),
                       (H - сверху - снизу) / Math.max(z1 - z0, 600));
    const в_мир = (x, z) => [слева + (x - x0) * k, сверху + (z1 - z) * k];

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" ` +
      `font-family="Onest, Arial, sans-serif" id="км_план_svg" style="touch-action:none">`;
    svg += `<text x="${слева}" y="30" font-size="15" font-weight="700" fill="#111827">` +
      `План сверху: модуль можно перетащить мышью по X и Y</text>`;

    // комнатная сетка и стены
    const [кx, кz] = в_мир(0, 0);
    svg += `<line x1="${кx}" y1="${кz}" x2="${слева + (x1 - x0) * k}" y2="${кz}" stroke="#c9c3b6" stroke-width="2"/>`;
    svg += `<line x1="${кx}" y1="${кz}" x2="${кx}" y2="${сверху + (z1 - z0) * k}" stroke="#c9c3b6" stroke-width="2"/>`;
    svg += `<text x="${слева + 6}" y="${кz + 16}" font-size="10.5" fill="#9ca3af">задняя стена</text>`;
    svg += `<text x="${кx + 6}" y="${сверху + 12}" font-size="10.5" fill="#9ca3af">левая стена</text>`;

    const рис = (м, заливка, подпись) => {
      const [мx, мz] = в_мир(м.мир.x0, м.мир.z1);
      const ш = Math.max(2, (м.мир.x1 - м.мир.x0) * k);
      const г = Math.max(2, (м.мир.z1 - м.мир.z0) * k);
      const выбр = м.id === выделенный;
      let s = `<g data-план="${м.id}" style="cursor:grab">` +
        `<rect x="${мx.toFixed(1)}" y="${мz.toFixed(1)}" width="${ш.toFixed(1)}" height="${г.toFixed(1)}" ` +
        `fill="${выбр ? "#fde68a" : заливка}" stroke="${выбр ? "#b45309" : "#1f2937"}" stroke-width="1.4"/>`;
      if (ш > 42 && г > 22) {
        s += `<text x="${(мx + ш / 2).toFixed(1)}" y="${(мz + г / 2 - 2).toFixed(1)}" text-anchor="middle" ` +
          `font-size="12" font-weight="700" fill="#111827">${Math.round(м.ширина)}</text>` +
          `<text x="${(мx + ш / 2).toFixed(1)}" y="${(мz + г / 2 + 12).toFixed(1)}" text-anchor="middle" ` +
          `font-size="10" fill="#4b5563">${подпись}</text>`;
      }
      return s + `</g>`;
    };
    // верхний ряд — за нижним, чтобы не перекрывал подписи
    for (const м of верх) svg += рис(м, "#e6edf7", "верх");
    for (const м of низ) svg += рис(м, "#f1efe9", "низ");

    // техника — тонким контуром, читаемость «лицом в комнату»
    for (const т of данные.техника || []) {
      if (!т.ширина || !т.глубина) continue;
      const плечо = т.плечо || "задняя";
      const x_м = плечо === "задняя" ? т.x : т.x;
      const z_м = плечо === "задняя" ? т.z : т.z;
      const ш_м = плечо === "задняя" ? т.ширина : т.глубина;
      const г_м = плечо === "задняя" ? т.глубина : т.ширина;
      const [тx, тz] = в_мир(x_м, z_м + г_м);
      svg += `<rect x="${тx.toFixed(1)}" y="${тz.toFixed(1)}" width="${Math.max(2, ш_м * k).toFixed(1)}" ` +
        `height="${Math.max(2, г_м * k).toFixed(1)}" fill="none" stroke="#b45309" stroke-width="1.1" stroke-dasharray="4 3"/>`;
    }

    svg += `<line x1="${слева}" y1="${H - 34}" x2="${слева + (x1 - x0) * k}" y2="${H - 34}" stroke="#1f2937" stroke-width="1.2"/>`;
    svg += `<text x="${(слева + (x1 - x0) * k / 2).toFixed(0)}" y="${H - 16}" text-anchor="middle" font-size="13" ` +
      `font-weight="700" fill="#111827">${Math.round(x1 - x0)} мм по X</text>`;
    svg += `<text x="12" y="${H - 16}" font-size="11" fill="#6b7280">Модулей: ${модули.length}. ` +
      `Глубина — от стены к комнате (вниз).</text></svg>`;
    return svg;
  }

  function планПоказать(да) {
    if (да) {
      планБлок.innerHTML = планSVG();
      планБлок.style.display = "block";
      рендерер.domElement.style.visibility = "hidden";
    } else {
      планБлок.style.display = "none";
      рендерер.domElement.style.visibility = "visible";
    }
  }

  /* расстояние, на котором кухня целиком влезает в кадр при данном направлении.
     Считаем по 8 углам реального габарита: для каждого угла нужно
     dist ≥ |боковое смещение| / tan(полуугла) + смещение вдоль оси взгляда. */
  function расстояниеВписать(направление) {
    const tanV = Math.tan((камера.fov * Math.PI / 180) / 2);
    const tanH = tanV * Math.max(камера.aspect, 0.5);
    const ц = габарит.центр;
    const f = направление.clone().normalize();
    const право = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), f).normalize();
    const верх = new THREE.Vector3().crossVectors(f, право).normalize();
    const б = габарит.коробка;
    if (!б) return 4;
    let надо = 2.2;
    for (const x of [б.min.x, б.max.x]) {
      for (const y of [б.min.y, б.max.y]) {
        for (const z of [б.min.z, б.max.z]) {
          const v = new THREE.Vector3(x, y, z).sub(ц);
          const вдоль = v.dot(f);
          надо = Math.max(надо,
            Math.abs(v.dot(право)) / tanH + вдоль,
            Math.abs(v.dot(верх)) / tanV + вдоль);
        }
      }
    }
    return надо * 1.12;                          // запас на поля, чтобы верхний ряд не обрезался
  }

  function направлениеВида(имя) {
    if (имя === "спереди") return new THREE.Vector3(0, 0.04, -1);
    if (имя === "сверху") return new THREE.Vector3(0, 1, -0.08);
    return new THREE.Vector3(0.52, 0.34, -0.78);
  }

  /* плавный подлёт камеры к новой точке (смена длины, сброс вида).
     Цель анимируется вместе с позицией: иначе камера едет, а взгляд уже
     перепрыгнул — картинка «дёргается». */
  function анимироватьКамеру(куда, мс = 320, цель = null) {
    const от = камера.position.clone();
    const цель_от = управление.target.clone();
    const цель_куда = цель ? цель.clone() : цель_от;
    const t0 = performance.now();
    if (анимироватьКамеру._кадр) cancelAnimationFrame(анимироватьКамеру._кадр);
    const шагКадр = () => {
      const п = Math.min(1, (performance.now() - t0) / мс);
      const е = 1 - Math.pow(1 - п, 3);              // ease-out
      камера.position.copy(от).lerp(куда, е);
      управление.target.copy(цель_от).lerp(цель_куда, е);
      управление.update();
      отрисоватьСразу();
      анимироватьКамеру._кадр = п < 1 ? requestAnimationFrame(шагКадр) : null;
    };
    шагКадр();
  }

  /* ── «домашний вид»: точка, куда возвращает «Сброс вида» ────────────────
     Не «какой-нибудь 3/4», а ровно тот вид, который сцена показала сама:
     центр габарита кухни + направление три четверти + расстояние, на котором
     кухня влезает в кадр. Фиксируется при инициализации и после КАЖДОЙ
     пересборки (добавили модуль, сменили форму) — иначе сброс уводил камеру
     в похожее, но другое место (симптом блока D). */
  let домашнийВид = null;

  function зафиксироватьДомашний() {
    if (!габарит.центр) return;
    const n = направлениеВида("три_четверти");
    const д = расстояниеВписать(n);
    домашнийВид = {
      цель: габарит.центр.clone(),
      поз: габарит.центр.clone().add(n.clone().normalize().multiplyScalar(д)),
    };
  }

  function сбросВид() {
    накоплениеКолеса = 0;
    текущийВид = "три_четверти";
    планПоказать(false);
    if (!домашнийВид) { вид("три_четверти", true); зафиксироватьДомашний(); return; }
    управление.target.copy(домашнийВид.цель);
    анимироватьКамеру(домашнийВид.поз.clone(), 340, домашнийВид.цель.clone());
    отрисоватьСразу(true);
  }

  function вид(имя, без_анимации) {
    текущийВид = имя || текущийВид;
    накоплениеКолеса = 0;                    // кнопка вида сбрасывает недокрученное колесо
    планПоказать(текущийВид === "сверху");
    if (текущийВид === "сверху") { отрисоватьСразу(); return; }
    const ц = габарит.центр;
    const n = направлениеВида(текущийВид);
    const д = расстояниеВписать(n);
    const поз = ц.clone().add(n.clone().normalize().multiplyScalar(д));
    if (без_анимации) {
      камера.position.copy(поз);
      управление.target.copy(ц);
      управление.update();
      неПускатьВнутрь();                     // и после зума вид возвращает нормальную дистанцию
      управление.update();
      отрисоватьСразу(true);
      return;
    }
    управление.target.copy(ц);
    анимироватьКамеру(поз, 340, ц.clone());
    отрисоватьСразу(true);
  }

  /* Кнопки «+ / −» на экране: тот же шаг 8 %, что и у колеса, поэтому
     зум кнопкой и зум колесом дают одинаковый результат. */
  function зум(направление) {
    накоплениеКолеса = 0;
    приблизить(направление > 0 ? 1 - ШАГ_ЗУМА : 1 + ШАГ_ЗУМА);
  }

  function выделить(id) {
    выделенный = id || null;
    if (рамка) { кухня.remove(рамка); рамка.geometry.dispose(); рамка.material.dispose(); рамка = null; }
    if (!id) { отрисоватьСразу(); return; }
    const г = группыМодулей.find((х) => х.userData.модульId === id);
    if (!г) { отрисоватьСразу(); return; }
    const б = new THREE.Box3().expandByObject(г);
    б.expandByScalar(0.008);
    рамка = new THREE.Box3Helper(б, new THREE.Color(0xe89a1f));
    кухня.add(рамка);
    отрисоватьСразу();
  }

  /* ── отрисовка по требованию (и пауза, когда блок вне экрана) ─────────── */
  let кадр = null;
  let наЭкране = true;
  function отрисоватьСразу(сила) {
    if (!наЭкране && !сила) return;           // вне экрана не тратим GPU/батарею…
    рендерер.render(сцена, камера);           // …но действие человека рисуем всегда
  }
  /* ЯВНАЯ перерисовка после изменения опции: кадр сейчас + кадр через rAF.
     Это и есть ответ на «цена пересчиталась, а картинка старая». */
  function перерисовать() {
    отрисоватьСразу(true);
    запросить();
  }
  function пауза(да) {
    наЭкране = !да;
    if (наЭкране) отрисоватьСразу();
  }
  function цикл() {
    кадр = null;
    if (!наЭкране) return;                    // блок вне экрана — цикл не крутим
    const двинулось = управление.update();
    рендерер.render(сцена, камера);
    if (двинулось) кадр = requestAnimationFrame(цикл);
  }
  function запросить() {
    if (кадр === null) кадр = requestAnimationFrame(цикл);
  }
  управление.addEventListener("change", запросить);
  управление.addEventListener("start", запросить);
  управление.addEventListener("end", запросить);

  function размер() {
    const ш = хост.clientWidth || (хост.parentElement && хост.parentElement.clientWidth) || 800;
    const в = хост.clientHeight || (хост.parentElement && хост.parentElement.clientHeight) || 500;
    рендерер.setSize(ш, в, false);
    камера.aspect = ш / в;
    камера.updateProjectionMatrix();
    отрисоватьСразу();
  }
  const наблюдатель = new ResizeObserver(размер);
  наблюдатель.observe(хост);
  if (хост.parentElement) наблюдатель.observe(хост.parentElement);
  // раскладка блока может «дорасти» после первой отрисовки — подгоняем ещё раз
  requestAnimationFrame(размер);
  setTimeout(размер, 350);

  /* ── выбор и перетаскивание модулей ──────────────────────────────────── */
  const луч = new THREE.Raycaster();
  const точка = new THREE.Vector2();
  let обработчики = { наВыбор: null, наПеретаскивание: null, наОтказ: null };
  let тащим = null;
  let рамкаОшибки = null;

  function попадание(событие) {
    const прямоугольник = рендерер.domElement.getBoundingClientRect();
    точка.x = ((событие.clientX - прямоугольник.left) / прямоугольник.width) * 2 - 1;
    точка.y = -((событие.clientY - прямоугольник.top) / прямоугольник.height) * 2 + 1;
    луч.setFromCamera(точка, камера);
    const попадания = луч.intersectObjects(меши, false);
    return попадания.length ? попадания[0].object : null;
  }

  /* мировая точка на полу под курсором */
  const плоскость = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function наПолу(событие) {
    const прямоугольник = рендерер.domElement.getBoundingClientRect();
    точка.x = ((событие.clientX - прямоугольник.left) / прямоугольник.width) * 2 - 1;
    точка.y = -((событие.clientY - прямоугольник.top) / прямоугольник.height) * 2 + 1;
    луч.setFromCamera(точка, камера);
    const п = new THREE.Vector3();
    return луч.ray.intersectPlane(плоскость, п) ? п : null;
  }

  function мирПри(м, дx, дz) {
    const б = м.мир || {};
    return { x0: б.x0 + дx, x1: б.x1 + дx, z0: б.z0 + дz, z1: б.z1 + дz };
  }
  function пересекается(а, б) {
    return а.x0 < б.x1 - 1 && а.x1 > б.x0 + 1 && а.z0 < б.z1 - 1 && а.z1 > б.z0 + 1;
  }
  /* можно ли поставить модуль так: не за стену и без пересечений в своём ряду */
  function местоСвободно(м, дx, дz) {
    const свой = мирПри(м, дx, дz);
    if (свой.x0 < -1 || свой.z1 > 40) return false;          // за левую/заднюю стену
    for (const др of данныеСцены.модули || []) {
      if (др.id === м.id || !др.мир || др.тень) continue;
      if (др.ряд !== м.ряд) continue;                        // верх и низ не конфликтуют
      if ((др.плечо || "задняя") !== (м.плечо || "задняя")) continue;
      if (пересекается(свой, др.мир)) return false;
    }
    return true;
  }

  function подсветитьОшибку(г, да) {
    if (да && !рамкаОшибки && г) {
      рамкаОшибки = new THREE.BoxHelper(г, 0xd93025);
      рамкаОшибки.material.depthTest = false;
      сцена.add(рамкаОшибки);
    } else if (!да && рамкаОшибки) {
      сцена.remove(рамкаОшибки);
      if (рамкаОшибки.geometry) рамкаОшибки.geometry.dispose();
      рамкаОшибки = null;
    }
  }

  рендерер.domElement.addEventListener("pointerdown", (е) => {
    if (е.button !== 0) return;
    // На сенсоре палец НЕ таскает модуль: иначе pinch (два пальца) превращается
    // в перетаскивание — первый pointerdown попадает по мебели и выключает
    // управление. На телефоне: один палец — поворот, два — масштаб (как в ТЗ).
    if (е.pointerType === "touch") return;
    const меш = попадание(е);
    if (!меш) return;
    const точкаПол = наПолу(е);
    const данныеМодуля = (данныеСцены.модули || []).find((м) => м.id === меш.userData.модульId);
    тащим = {
      id: меш.userData.модульId, x0: е.clientX, y0: е.clientY, двигали: false,
      группа: группыМодулей.find((г) => г.userData.модульId === меш.userData.модульId) || null,
      модуль: данныеМодуля, старт: точкаПол, дx: 0, дz: 0, ок: true,
    };
    if (рендерер.domElement.setPointerCapture) рендерер.domElement.setPointerCapture(е.pointerId);
  });

  рендерер.domElement.addEventListener("pointermove", (е) => {
    if (!тащим) {
      рендерер.domElement.style.cursor = попадание(е) ? "grab" : "move";
      return;
    }
    const дпикс = Math.hypot(е.clientX - тащим.x0, е.clientY - тащим.y0);
    if (!тащим.двигали && дпикс < 5) return;
    тащим.двигали = true;
    управление.enabled = false;
    рендерер.domElement.style.cursor = "grabbing";
    const т = наПолу(е);
    if (!т || !тащим.старт || !тащим.модуль) return;
    тащим.дx = т.x - тащим.старт.x;
    тащим.дz = т.z - тащим.старт.z;
    тащим.ок = местоСвободно(тащим.модуль, тащим.дx, тащим.дz);
    if (тащим.группа) тащим.группа.position.set(тащим.дx, 0, тащим.дz);
    подсветитьОшибку(тащим.группа, !тащим.ок);
    отрисоватьСразу();
  });

  function отпустить(е) {
    if (!тащим) return;
    const закончили = тащим;
    тащим = null;
    рендерер.domElement.style.cursor = "move";
    управление.enabled = true;
    подсветитьОшибку(null, false);
    if (закончили.двигали && закончили.модуль && закончили.группа) {
      if (!закончили.ок) {
        // нельзя: возвращаем на последнюю допустимую позицию (как было)
        закончили.группа.position.set(0, 0, 0);
        отрисоватьСразу();
        if (обработчики.наОтказ) обработчики.наОтказ(закончили.id);
      } else if (обработчики.наПеретаскивание) {
        const м = закончили.модуль;
        const б = м.мир;
        let x_плеча, отступ;
        if ((м.плечо || "задняя") === "задняя") {
          x_плеча = б.x0 + закончили.дx;
          отступ = -б.z1 - закончили.дz;
        } else {
          x_плеча = -б.z1 - закончили.дz;
          отступ = б.x0 + закончили.дx;
        }
        обработчики.наПеретаскивание(закончили.id, Math.round(x_плеча), Math.round(Math.max(0, отступ)));
      } else {
        закончили.группа.position.set(0, 0, 0);
      }
    } else if (!закончили.двигали && обработчики.наВыбор) {
      обработчики.наВыбор(закончили.id);
    }
  }
  рендерер.domElement.addEventListener("pointerup", отпустить);
  рендерер.domElement.addEventListener("pointercancel", () => {
    if (тащим && тащим.группа) тащим.группа.position.set(0, 0, 0);
    тащим = null; управление.enabled = true; подсветитьОшибку(null, false); отрисоватьСразу();
  });
  рендерер.domElement.addEventListener("pointerleave", () => { if (!тащим) рендерер.domElement.style.cursor = "move"; });

  /* ── перетаскивание на плане сверху ──────────────────────────────────── */
  (function планТащить() {
    let т = null;
    планБлок.addEventListener("pointerdown", (е) => {
      const г = е.target.closest("[data-план]");
      if (!г) return;
      const id = г.getAttribute("data-план");
      const м = (данныеСцены.модули || []).find((х) => х.id === id);
      if (!м) return;
      const свг = планБлок.querySelector("svg");
      if (!свг) return;
      const р = свг.getBoundingClientRect();
      т = { id, м, г, x0: е.clientX, y0: е.clientY, дx: 0, дz: 0, ок: true,
            k: р.width / 1000, двигали: false };
      г.style.opacity = "0.75";
      if (обработчики.наВыбор) обработчики.наВыбор(id);
      if (свг.setPointerCapture) свг.setPointerCapture(е.pointerId);
    });
    планБлок.addEventListener("pointermove", (е) => {
      if (!т) return;
      т.дx = (е.clientX - т.x0) / т.k;
      т.дz = -(е.clientY - т.y0) / т.k;
      if (!т.двигали && Math.hypot(т.дx, т.дz) < 4) return;
      т.двигали = true;
      т.ок = местоСвободно(т.м, т.дx, т.дz);
      т.г.setAttribute("transform", "translate(" + (т.дx * т.k) + " " + (-т.дz * т.k) + ")");
      т.г.style.opacity = т.ок ? "0.85" : "0.55";
    });
    const конец = () => {
      if (!т) return;
      const з = т; т = null;
      if (!з.двигали) { планПоказать(true); return; }
      if (!з.ок) {
        планПоказать(true);
        if (обработчики.наОтказ) обработчики.наОтказ(з.id);
        return;
      }
      const б = з.м.мир;
      let x_плеча, отступ;
      if ((з.м.плечо || "задняя") === "задняя") {
        x_плеча = б.x0 + з.дx; отступ = -б.z1 - з.дz;
      } else {
        x_плеча = -б.z1 - з.дz; отступ = б.x0 + з.дx;
      }
      if (обработчики.наПеретаскивание) {
        обработчики.наПеретаскивание(з.id, Math.round(x_плеча), Math.round(Math.max(0, отступ)));
      }
    };
    планБлок.addEventListener("pointerup", конец);
    планБлок.addEventListener("pointercancel", конец);
  })();

  /* ── управление на телефоне: включается явной кнопкой ────────────────── */
  function включитьУправление(да) {
    управление.enabled = Boolean(да);
    рендерер.domElement.style.touchAction = да ? "none" : "pan-y";
  }
  включитьУправление(!("ontouchstart" in window));

  /* ── смена отделки без пересборки: только цвет и текстура ────────────── */
  function обновитьОтделку(данные, конфиг) {
    фасадМатериал = цветФасада(конфиг, данные.фасад || (данные.сборка && данные.сборка.фасад));
    столешницаМатериал = цветСтолешницы(конфиг, данные.столешница_id
      || (данные.сборка && данные.сборка.столешница_id));
    задатьОтделку("фасад", фасадМатериал && фасадМатериал.цвет,
                  (фасадМатериал && фасадМатериал.вид) || "нет", false);
    задатьОтделку("столешница", столешницаМатериал && столешницаМатериал.цвет,
                  (столешницаМатериал && столешницаМатериал.вид) || "нет", false);
    обновитьШвыФасадов();          // шов створки — часть фасада, меняется вместе с ним
    построитьФартук(данные.фартук);   // фартук меняется мгновенно, без пересборки кухни
    перерисовать();                // кадр сейчас + кадр через rAF, без ожидания мыши
    if (данныеСцены) {
      данныеСцены.фасад = данные.фасад;
      данныеСцены.столешница_id = данные.столешница_id;
    }
  }

  /* ── скриншот сцены (для заявки) ─────────────────────────────────────── */
  function картинка(тип = "image/jpeg", качество = 0.72) {
    рендерер.render(сцена, камера);            // даже если блок вне экрана
    return рендерер.domElement.toDataURL(тип, качество);
  }

  function уничтожить() {
    наблюдатель.disconnect();
    управление.dispose();
    for (const м of материалы.values()) м.dispose();
    for (const т of текстуры.values()) т.dispose();
    рендерер.dispose();
    if (рендерер.domElement.parentNode) рендерер.domElement.parentNode.removeChild(рендерер.domElement);
  }

  return {
    построить, вид, сбросВид, зум, выделить, размер, уничтожить, картинка, включитьУправление,
    обновитьОтделку, пауза, перерисовать, показатьПолки, поворотПоСтене,
    планВиден: () => планБлок.style.display !== "none",
    фартук: построитьФартук,
    фартукЕсть: () => Boolean(фартукГруппа && фартукГруппа.children.length),
    домашнийВид: () => домашнийВид, версия: ВЕРСИЯ_СЦЕНЫ,
    // мостик для проверок (только чтение): дистанция от камеры до поверхности
    // мебели — по ней видно, зашла ли камера внутрь модулей
    расстояниеДоМодели: дистанцияДоКухни,
    коробка: () => габарит.коробка || null,
    наВыбор(ф) { обработчики.наВыбор = ф; },
    наОтказ(ф) { обработчики.наОтказ = ф; },
    наПеретаскивание(ф) { обработчики.наПеретаскивание = ф; },
    элементы: { рендерер, сцена, камера, управление },
  };
}
