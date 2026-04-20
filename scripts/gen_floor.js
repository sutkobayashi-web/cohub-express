#!/usr/bin/env node
// フロア別の俯瞰オフィス背景を Gemini 2.5 Flash Image で生成
// 使い方: node scripts/gen_floor.js <code>
//   code: lobby | office
// 出力: public/assets/floor_<code>.png
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const COMMON = `STRICT ORTHOGRAPHIC TOP-DOWN FLOOR PLAN VIEW.
CRITICAL: Pure overhead view at exactly 90 degrees from above. Roof removed. NO perspective distortion. NO isometric projection. NO 3D tilt. All furniture seen from directly above as their top surfaces only.
Soft realistic lighting with subtle shadows directly beneath furniture (no long cast shadows). No people visible.
Warm oak hardwood floor with visible plank lines. Walls on all 4 sides.
Style: architectural top-view plan rendering with photorealistic textures, clean and professional.
WIDE 16:9 horizontal rectangular canvas.`;

const PROMPTS = {
  lobby: `${COMMON}

Layout: 1F ENTRANCE LOBBY of a modern Japanese corporate office, focused on visitor reception.

**IMPORTANT**: NO TEXT, NO LETTERS, NO LOGOS, NO SIGNS, NO WRITTEN WORDS, NO ALPHABET CHARACTERS ANYWHERE. Completely blank walls and blank floor (no writing of any kind).

- Lower wall: MAIN ENTRANCE double glass automatic sliding door with plain red welcome mat (no text on mat)
- Upper-center: LARGE RECEPTION COUNTER (long curved desk) with 2 reception chairs behind it (no sign, no text plate)
- Upper-left: visitor waiting area - two L-shaped grey sofas facing each other, rectangular wooden coffee table, floor lamp
- Upper-right: second waiting area - 3 individual lounge chairs around a round coffee table, tall potted palm
- Left-middle wall: elevator bank (3 plain elevator doors) and stairs going up
- Right-middle: plain shelf with magazines (no signs)
- Center floor: OPEN WALKING AREA with plain wooden flooring (NO logo, NO letters on floor)
- Left-bottom: security guard booth (small counter) with chair
- Right-bottom: small standing pole
- Four corners: lush potted plants (green circles)

Style: welcoming, spacious, bright, corporate entrance hall feeling. Polished wood floor. Empty of people AND empty of any written/printed text or logos.`,

  office: `${COMMON}

Layout: 2F OPEN OFFICE floor for administrative staff, with SPACIOUS desk layout.
- Upper wall: 3-4 large windows
- Lower wall: staircase and elevator entrance
- Main area: **EXACTLY 15 desks AND EXACTLY 15 chairs, paired 1:1** (every desk has exactly one chair behind it; no extra chairs anywhere; no desk without a chair; no chair without a desk). Arrange as **3 ROWS × 5 COLUMNS** grid.
- **WIDE SPACING between desks**: at least one desk-width of empty aisle between rows and between individual desks (enough room for a chair and a person to stand/walk comfortably)
- Each desk-chair pair (desk top rectangle wooden, 2 dark monitor rectangles, ONE small circle chair directly behind). Count carefully: 15 desks × 1 chair each = 15 chairs total.
- Right wall: filing cabinets (tall rectangles) and a printer
- Left wall: whiteboard + notice boards
- 4 corners: large potted plants (green circles)
- A small breakroom cutout in top-right corner with round table and 2 chairs
- Plenty of empty floor space between desk clusters - NOT cramped

Colors: beige/white desks, dark grey monitors, grey chairs, green plants. Organized, professional, empty office scene with comfortable personal space per desk.`,

  meeting_a: `${COMMON}

Layout: 3F EXECUTIVE BOARDROOM - high-end formal executive boardroom for board members and senior management.
- Walls: 4 solid walls in soft warm taupe / champagne color, premium feel
- Floor: dark herringbone hardwood (instead of standard plank)
- Center: LARGE BOAT-SHAPED conference table made of HIGHLY POLISHED DARK MAHOGANY (you can see the rich grain and reflective sheen from above), seats 12
- Around table: 12 high-back executive chairs in BLACK SOFT LEATHER (slightly larger circles than normal chairs to suggest premium size), seen from directly above
- Center of table: a sleek BLACK CONFERENCE SPEAKER PHONE (round, dark) and small leather portfolio at each seat
- Upper wall: VERY LARGE wall-mounted PRESENTATION DISPLAY (a long dark rectangle, premium thin bezel) with a slim CONFERENCE CAMERA BAR mounted just below it
- Right wall: low SLEEK CREDENZA in dark wood with neat row of crystal water carafes, glasses, leather notebooks
- Left wall: tall vertical accent panel with subtle decoration (no text)
- Lower wall: solid wood door with brushed metal handle, no mat
- Ceiling (viewed top-down): inset RECESSED LIGHTING strip over the table + 2 elegant pendant lights
- Corners: minimal — just one tall sculptural potted plant in upper-right and lower-left corners (skip the other 2 corners for a less cluttered, more premium look)
Colors: deep mahogany + black leather + champagne taupe walls + brushed brass accents. Subdued, prestigious, expensive board-room atmosphere.`,

  meeting_b: `${COMMON}

Layout: 3F MEETING ROOM B - small modern corporate conference room (NOT casual, NOT a brainstorm space).
- Walls: 4 solid walls in cool light grey, clean modern feel
- Floor: light grey-toned engineered wood plank
- Center: MEDIUM OVAL/PILL-SHAPED meeting table (polished walnut wood with subtle dark grain, crisp clean edge), seats 6
- Around table: 6 modern mid-century executive chairs in CHARCOAL GREY LEATHER (small dark circles from above)
- Center of table: a small black conference speaker phone, neat row of water glasses, slim leather portfolios
- Upper wall: large wall-mounted PRESENTATION SCREEN (clean dark rectangle, thin bezel) with small camera bar
- Right wall: low minimalist credenza in matte dark wood with a single decorative vase
- Left wall: clean accent panel with one large abstract framed print (no text), brushed brass wall sconce
- Lower wall: glass entrance door with brushed metal frame
- Ceiling (viewed top-down): inset LED light strip over the table
- Corners: 1 small modern potted plant (only one corner — keep mostly minimal)
Colors: walnut wood + charcoal grey leather + cool grey walls + soft brass accents. Sleek, modern, professional corporate meeting space.`,

  field_rest: `${COMMON}

Layout: DRIVER/STAFF REST ROOM (乗務員詰所) - cozy break room for truck drivers and warehouse workers.
- Walls: 4 solid walls enclosed room
- Main area: L-shaped grey sofa + 2 armchairs around a rectangular low table, casual seating for 8 people
- Upper wall: large TV screen mounted on wall, clock
- Right wall: kitchenette with coffee maker, microwave, small sink, vending machine
- Left wall: lockers (row of tall rectangles), noticeboard
- Corner: small round table with 4 chairs for eating
- Floor: easy-clean vinyl in warm grey, door at bottom
- Corners: a couple of potted plants
Colors: warm grey + beige + wood tones. Utilitarian but comfortable, working-class rest space.`,

  field_work: `${COMMON}

Layout: WAREHOUSE WORKSHOP FLOOR (倉庫作業室) - packing and sorting area.
- Walls: concrete warehouse style, 4 solid walls
- Main area: 3 long stainless steel work tables arranged in a U-shape, each with packaging supplies, boxes, tape dispensers, labels
- Right wall: tall metal shelving with cardboard boxes stacked
- Left wall: pallet stacking area, forklift charging station, hand trucks
- Upper wall: roll-up shutter door (big grey rectangle) leading to loading bay
- Floor: polished concrete with yellow safety line markings (but NO TEXT or letters)
- 2 small standing desks with computers for inventory
- A few potted plants near entrance
Colors: industrial grey + yellow safety accents. Organized warehouse environment.`,

  field_meet: `${COMMON}

Layout: FIELD TEAM MEETING ROOM (現場ミーティング室) - for driver briefings and safety meetings.
- Walls: 4 solid walls making an enclosed meeting room
- Center: long rectangular table with 10-12 chairs around it (sturdy, simple chairs)
- Upper wall: large whiteboard with route maps and schedules (NO TEXT visible, just abstract marks)
- Right wall: safety notice board (plain corkboard), helmet/vest storage rack
- Left wall: simple pinboard, clock
- Lower wall: entrance door
- Table top: notebooks, clipboards, water bottles, a tablet
- Corners: 2 potted plants
Colors: utilitarian beige walls + dark wood table + orange safety accents. Functional meeting space.`,

  meeting_c: `${COMMON}

Layout: 3F PREMIUM LARGE CONFERENCE HALL - prestigious corporate all-hands hall seating ~30 people.
- Walls: 4 solid walls in warm champagne tone with subtle vertical wood paneling on upper and side walls (premium feel)
- Floor: dark polished hardwood with very faint herringbone pattern
- Upper wall: VERY LARGE wall-mounted PRESENTATION DISPLAY (huge dark rectangle, thin premium bezel) flanked by 2 narrow vertical accent strips, slim conference camera bar just below the display
- Layout: U-SHAPED arrangement of 3 long rectangular conference tables:
  - Top horizontal table (below display): seats 10 chairs facing the display
  - Left vertical table: seats 8 chairs facing right
  - Right vertical table: seats 8 chairs facing left
  - Additional row of 4 loose chairs at the bottom-center (observer seats)
- All chairs visible as small circles in BLACK LEATHER (approximately 30 chairs total)
- Each seat has a small crystal water glass and slim leather portfolio
- Tables: HIGHLY POLISHED DARK MAHOGANY wood with reflective sheen, brushed brass edge trim
- Center of U-shape (interior open floor): subtle inset rectangular accent rug in deep charcoal
- Left wall: sleek dark credenza with crystal water carafes, microphones lined up neatly, brushed brass desk lamp
- Right wall: AV control console (black panel) and shelf with leather-bound binders
- Lower wall: DOUBLE solid wood entrance doors with brushed brass handles (no mat)
- Ceiling (hinted top-down): inset RECESSED LIGHTING strip running along the U-shape + 2 elegant rectangular pendant lights over the U interior
- Corners: just 2 minimal sculptural plants in upper-left and lower-right (skip the other 2 corners for a cleaner premium look)
Colors: dark mahogany + black leather + champagne walls + brushed brass accents.
Style: highly formal, prestigious, board-of-directors-grade conference hall, expensive premium feeling, no casual elements.`,
};

(async () => {
  const code = (process.argv[2] || 'lobby').toLowerCase();
  const prompt = PROMPTS[code];
  if (!prompt) { console.error('unknown floor code:', code, '(expected: lobby|office)'); process.exit(1); }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.85,
      imageConfig: { aspectRatio: '16:9' }
    }
  };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { console.error('HTTP', r.status, await r.text()); process.exit(1); }
  const d = await r.json();
  const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
  if (!parts) { console.error('no parts'); process.exit(1); }
  for (const p of parts) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const out = path.join(__dirname, '..', 'public', 'assets', 'floor_' + code + '.png');
      fs.writeFileSync(out, Buffer.from(inline.data, 'base64'));
      console.log('saved', out, Buffer.from(inline.data, 'base64').length, 'bytes');
      return;
    }
  }
  console.error('no image in parts');
  process.exit(1);
})();
