// Scenarios for the browser harness. Each supplies the sheet rows MagicTools
// should return, a script that drives the page, and the expected probe lines.
//
// The probe protocol: the driver script appends <div class="probe"> elements;
// the runner scrapes their text and compares.

export const SHEET_ROWS_ROOT_ONLY = [
  ['Balance Statement Inquiry', 'Balance Statement Inquiry\n', '2026-08-07', ''],
];

export const SCENARIOS = [
  {
    name: 'root is auto-selected and only + child is enabled',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      probe('buttons ' + buttons());
    `,
    expect: ['buttons kind=OFF addChild=on addSib=OFF del=OFF'],
  },
  {
    name: 'Tab then typing then Enter builds a chain',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      key(document, 'Tab');
      await tick();
      type('Open dashboard');
      key(fastEl(), 'Enter');
      await tick();
      type('Input identity ID');
      key(fastEl(), 'Escape');
      await tick();
      probe('titles ' + titles().join('|'));
    `,
    expect: ['titles Balance Statement Inquiry|Open dashboard|Input identity ID'],
  },
  {
    name: 'Enter on an empty fresh node removes it',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      key(document, 'Tab');
      await tick();
      type('Only step');
      key(fastEl(), 'Enter');
      await tick();
      key(fastEl(), 'Enter');
      await tick();
      probe('titles ' + titles().join('|'));
    `,
    expect: ['titles Balance Statement Inquiry|Only step'],
  },
  {
    name: 'Tab does not move browser focus',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      key(document, 'Tab');
      await tick();
      probe('focus ' + (document.activeElement && document.activeElement.id));
    `,
    expect: ['focus fastEdit'],
  },
  {
    name: 'pasting a numbered list creates a step chain',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      paste('1. Open dashboard\\n2. Input identity ID\\n   - confirm W number\\n');
      await tick();
      probe('titles ' + titles().join('|'));
    `,
    expect: [
      'titles Balance Statement Inquiry|Open dashboard|Input identity ID|confirm W number',
    ],
  },
  {
    name: 'the fast editor tracks zoom',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      document.getElementById('zoomReset').click();
      document.getElementById('zoomIn').click();
      key(document, 'Tab');
      await tick();
      var left = parseFloat(fastEl().style.left);
      var box = document.querySelector('#scaler g[data-node-uid="2"] rect');
      var want = (Number(box.getAttribute('x')) + 6) * 1.25;
      probe('zoomed ' + (Math.abs(left - want) < 1));
    `,
    expect: ['zoomed true'],
  },
];
