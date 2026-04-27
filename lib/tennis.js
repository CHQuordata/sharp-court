export function getSurface(venue) {
  const v = (venue || '').toLowerCase().replace(/_/g, ' ');
  if (/\bclay\b|terre battue|tierra batida|arcilla/.test(v)) return 'clay';
  if (/\bgrass\b/.test(v)) return 'grass';
  if (/\bindoor hard\b/.test(v)) return 'indoor';
  if (/roland garros|french open|madrid open|caja.m.gica|mutua.*madrid|rome\b|roma\b|foro italico|internazionali|foro.italico|bnl|barcelona|real club de tenis|conde de god|monte.carlo|monte carlo|rolex.*monte|atp.*monte|geneva|lyon|hamburg|am rothenbaum|bucharest|munich|estoril|marrakech|marrakesh|istanbul|prague|strasbourg|cluj|budapest|bogota|houston|stuttgart|porsche.arena|porsche tennis|bmw open|rouen|oeiras|jamor|warsaw|warszawa|lausanne|palermo|bastad|b.?stad|rabat|kit[zs]b.hel|umag|gstaad|c.rdoba|buenos.aires|\brio\b|belgrade|beograd|casablanca|perugia|cagliari|florence|firenze|parco.*del.*foro|santiago|lima|montevideo|parma|salzburg|fes |marbella|bogot|open de france|open sabadell|banque.*monaco|grand prix de tennis|porsche grand prix|hungarian open|serbia open|nordea open|generali open|swiss open|croatia open|morocco open|millennium|leon|cordoba/.test(v)) return 'clay';
  if (/wimbledon|queen.s club|queens club|eastbourne|\bhalle\b|hertogenbosch|s-hertogenbosch|rosmalen|birmingham|nottingham|mallorca|antalya|bad homburg|devonshire park|surbiton|ilkley|edgbaston/.test(v)) return 'grass';
  if (/bercy|paris.master|paris-bercy|wien\b|vienna|wiener stadthalle|halle.*indoor|basel|st\.?jakobs|rotterdam|ahoy|marseille|palais des sports|montpellier|sofia\b|zagreb|antwerp|lotto.*arena|metz\b|milan.*indoor|indoor/.test(v)) return 'indoor';
  return 'hard';
}
