// 3-digit ZIP prefix -> US state, for picking a postal code that matches the
// proxy's geo (a zip that contradicts IP geo is a classic fraud signal).
// Standard USPS prefix ranges; military/territory prefixes are ignored.

const RANGES = [
  [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'],
  [50, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'],
  [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'],
  [200, 200, 'DC'], [201, 201, 'VA'], [202, 205, 'DC'], [206, 219, 'MD'],
  [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'],
  [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'],
  [386, 397, 'MS'], [398, 399, 'GA'], [400, 427, 'KY'], [430, 459, 'OH'],
  [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'],
  [550, 567, 'MN'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'],
  [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'],
  [700, 714, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'], [750, 799, 'TX'],
  [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'],
  [850, 865, 'AZ'], [870, 884, 'NM'], [889, 898, 'NV'], [900, 961, 'CA'],
  [967, 968, 'HI'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK'],
];

// US area code -> state (NANP, geographic codes only). Used when an event pins
// area codes: the postal code is then chosen from the phone's state so the
// number and the zip agree, regardless of the proxy's geo.
const AREA_CODES = {
  AL: [205, 251, 256, 334, 659, 938],
  AK: [907],
  AZ: [480, 520, 602, 623, 928],
  AR: [327, 479, 501, 870],
  CA: [209, 213, 279, 310, 323, 341, 350, 369, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951],
  CO: [303, 719, 720, 970, 983],
  CT: [203, 475, 860, 959],
  DE: [302],
  DC: [202, 771],
  FL: [239, 305, 321, 352, 386, 407, 448, 561, 645, 656, 689, 727, 728, 754, 772, 786, 813, 850, 863, 904, 941, 954],
  GA: [229, 404, 470, 478, 678, 706, 762, 770, 943],
  HI: [808],
  ID: [208, 986],
  IL: [217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 872],
  IN: [219, 260, 317, 463, 574, 765, 812, 930],
  IA: [319, 515, 563, 641, 712],
  KS: [316, 620, 785, 913],
  KY: [270, 364, 502, 606, 859],
  LA: [225, 318, 337, 504, 985],
  ME: [207],
  MD: [227, 240, 301, 410, 443, 667],
  MA: [339, 351, 413, 508, 617, 774, 781, 857, 978],
  MI: [231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 906, 947, 989],
  MN: [218, 320, 507, 612, 651, 763, 924, 952],
  MS: [228, 601, 662, 769],
  MO: [235, 314, 417, 557, 573, 636, 660, 816, 975],
  MT: [406],
  NE: [308, 402, 531],
  NV: [702, 725, 775],
  NH: [603],
  NJ: [201, 551, 609, 640, 732, 848, 856, 862, 908, 973],
  NM: [505, 575],
  NY: [212, 315, 329, 332, 347, 363, 516, 518, 585, 607, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934],
  NC: [252, 336, 472, 704, 743, 828, 910, 919, 980, 984],
  ND: [701],
  OH: [216, 220, 234, 283, 326, 330, 380, 419, 440, 513, 567, 614, 740, 937],
  OK: [405, 539, 572, 580, 918],
  OR: [458, 503, 541, 971],
  PA: [215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717, 724, 814, 835, 878],
  RI: [401],
  SC: [803, 821, 839, 843, 854, 864],
  SD: [605],
  TN: [423, 615, 629, 731, 865, 901, 931],
  TX: [210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 915, 936, 940, 945, 956, 972, 979],
  UT: [385, 435, 801],
  VT: [802],
  VA: [276, 434, 540, 571, 686, 703, 757, 804, 826, 948],
  WA: [206, 253, 360, 425, 509, 564],
  WV: [304, 681],
  WI: [262, 274, 353, 414, 534, 608, 715, 920],
  WY: [307],
};
const STATE_FOR_AREA = {};
for (const [st, codes] of Object.entries(AREA_CODES)) for (const c of codes) STATE_FOR_AREA[c] = st;

function stateForAreaCode(code) {
  return STATE_FOR_AREA[parseInt(String(code), 10)] || null;
}

function stateForZip(zip) {
  const p3 = parseInt(String(zip).slice(0, 3), 10);
  if (Number.isNaN(p3)) return null;
  for (const [min, max, st] of RANGES) {
    if (p3 >= min && p3 <= max) return st;
  }
  return null;
}

// Pick zips from `zips` that live in `state`. Falls back to the same first-digit
// region (plausible neighboring state), then to the full list.
function zipsForState(zips, state) {
  if (!state) return zips;
  const exact = zips.filter(z => stateForZip(z) === state);
  if (exact.length) return exact;
  const region = zips.filter(z => {
    const st = stateForZip(z);
    return st && z[0] === firstDigitForState(state);
  });
  return region.length ? region : zips;
}

function firstDigitForState(state) {
  for (const [min, max, st] of RANGES) {
    if (st === state) return String(min).padStart(3, '0')[0];
  }
  return null;
}

module.exports = { stateForZip, zipsForState, stateForAreaCode };
