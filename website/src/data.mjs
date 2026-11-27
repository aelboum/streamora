// Content of the EliteStream website, copied verbatim from the Claude Design source of truth:
// project "EliteStream site prototype", file "EliteStream Website.dc.html" (data script + markup).
// Platform and AI statuses use the design's property defaults; change them here per release.

export const SITE_URL = 'https://elitestreamplayer.com';

/** Design: STATUS (status colours and explanations). */
export const STATUS = {
  'Available': { cls: 'st-available', t: 'Tested and publicly released.' },
  'Beta': { cls: 'st-beta', t: 'Feature‑complete and in public testing. Expect occasional issues.' },
  'In development': { cls: 'st-dev', t: 'Actively being built and tested. Not yet released.' },
  'Planned': { cls: 'st-planned', t: 'On the roadmap. Development has not started.' }
};

/** Design props (defaults): tizenStatus, webosStatus, androidStatus, titanStatus, aiStatus. */
export const PROPS = {
  tizenStatus: 'In development',
  webosStatus: 'In development',
  androidStatus: 'In development',
  titanStatus: 'In development',
  aiStatus: 'Planned'
};

export const PAGES = ['home', 'features', 'platforms', 'ai', 'screenshots', 'downloads', 'support', 'about'];

export const TITLES = {
  home: 'EliteStream – Premium Cross-Platform IPTV Player',
  features: 'Features – EliteStream',
  platforms: 'Supported Platforms – EliteStream',
  ai: 'EliteStream AI',
  screenshots: 'Screenshots – EliteStream',
  downloads: 'Downloads – EliteStream',
  support: 'Support & FAQ – EliteStream',
  about: 'About – EliteStream'
};

/** Meta descriptions: the home text is the design's; the others are each page's own intro text. */
export const DESCRIPTIONS = {
  home: 'Discover EliteStream, a modern IPTV player for compatible Smart TVs. Enjoy Live TV, movies, series and intelligent entertainment features in one elegant application.',
  features: 'Four pillars shape EliteStream: live television, on‑demand libraries, intelligent assistance and a refined player.',
  platforms: 'We only list a platform as available once it has been tested. Status is updated with every release.',
  ai: 'EliteStream AI is being built to help you find, understand and enjoy content — in your language, from the sofa.',
  screenshots: 'Genuine captures from the application will appear here. We never publish mock‑ups as product screenshots.',
  downloads: 'Downloads appear here only once an approved public release exists. No third‑party mirrors are endorsed.',
  support: 'Installation, supported devices, troubleshooting, playback, playlists, EPG and AI — answers to common EliteStream questions.',
  about: 'EliteStream is a cross‑platform entertainment player for Smart TVs. EliteStream does not provide content.'
};

export const OG = {
  title: 'EliteStream – Premium Cross-Platform IPTV Player',
  description: 'A modern media player for compatible Smart TVs. Bring your own lawful content sources.'
};

export const NAV = [['home', 'Home'], ['features', 'Features'], ['platforms', 'Platforms'], ['ai', 'AI'], ['screenshots', 'Screenshots'], ['downloads', 'Downloads'], ['support', 'Support']];

export const FEATURES = [
  { num: '01', title: 'Live TV', accent: 'ac-cyan', headline: 'Live television, beautifully organised.', blurb: 'Browse channels by category, check what is on and switch instantly — all from the remote.', items: [
    { name: 'Live streaming', desc: 'Watch live channels from your own sources.' },
    { name: 'Channel navigation', desc: 'Fast up/down zapping and a clear channel list.' },
    { name: 'Channel categories', desc: 'Groups like News, Sport or Kids at a glance.' },
    { name: 'Programme guide', desc: 'An Electronic Programme Guide for now and next.' },
    { name: 'Audio tracks', desc: 'Choose between available audio tracks.' }] },
  { num: '02', title: 'Movies & Series', accent: 'ac-lilac', headline: 'Your on‑demand library, curated.', blurb: 'Movies and series presented with artwork, details and simple episode navigation.', items: [
    { name: 'Movie library', desc: 'Browse films from your sources.' },
    { name: 'Series library', desc: 'Seasons and episodes, neatly structured.' },
    { name: 'Search & filtering', desc: 'Find titles quickly.' },
    { name: 'Movie details', desc: 'Synopsis and information before you press play.' },
    { name: 'Episode navigation', desc: 'Move between episodes with ease.' },
    { name: 'My List', desc: 'Save titles to watch later.' }] },
  { num: '03', title: 'Smart Features', accent: 'ac-violet', headline: 'Assistance where it helps.', blurb: 'AI‑assisted guide data, translation and recommendations — rolling out in stages.', note: 'Status of each smart feature is listed on the AI page.', items: [
    { name: 'AI‑assisted EPG', desc: 'Help making guide data clearer.' },
    { name: 'Subtitle translation', desc: 'Subtitles in your language.' },
    { name: 'Recommendations', desc: 'Suggestions based on your library.' }] },
  { num: '04', title: 'Player Experience', accent: 'ac-ice', headline: 'A player built around the remote.', blurb: 'Focused controls, quick previews and a startup that picks up where you left off.', items: [
    { name: 'Playback controls', desc: 'Clear, focused on‑screen controls.' },
    { name: 'Last‑channel startup', desc: 'Optionally open on the last channel watched.' },
    { name: 'Preview', desc: 'Preview content before committing.' },
    { name: 'Remote navigation', desc: 'Every screen designed for D‑pad control.' }] }
];

export const AI = [
  ['AI Smart Search', 'Describe what you want to watch in natural language and find it in your library.'],
  ['EPG translation', 'Translate programme guide titles and descriptions into your language.'],
  ['Subtitle translation', 'Generate translated subtitles where the source provides subtitles.'],
  ['Movie recommendations', 'Suggestions drawn from your own library and viewing habits.'],
  ['AI Live TV assistant', 'Ask what is on, or what a programme is about, while watching.'],
  ['Audio track assistance', 'Help identifying and selecting the right audio language.']
];

/** [title, slot, wide on desktop] */
export const SHOTS = [['Live TV interface', 'live-tv', true], ['Channel list', 'channel-list', false], ['EPG', 'epg', false], ['Movie library', 'movies', false], ['Series library', 'series', false], ['Video player', 'player', true], ['Settings', 'settings', false]];

export const FAQ = [
  ['Installation guides', [['How do I install EliteStream?', 'Installation instructions for each platform will be published on the Downloads page together with the first public release.'], ['Where should I download EliteStream from?', 'Only from links on this website or official TV app stores listed here. We do not endorse third‑party mirrors.']]],
  ['Supported devices', [['Which TVs are supported?', 'EliteStream is being developed for Samsung (Tizen), LG (webOS), Philips Android TV and Philips Titan OS. See the Platforms page for the current status of each.'], ['Will my TV model work?', 'Tested models and OS versions will be listed per platform once testing is complete. We do not claim compatibility for untested devices.']]],
  ['Troubleshooting', [['The app is slow or unresponsive.', 'Restart the TV fully (unplug for 30 seconds), check your network connection and make sure your TV firmware is up to date.']]],
  ['Playback problems', [['A channel will not play.', 'Check that the stream works from your content provider and that your source is active. EliteStream plays content but does not host or repair streams.'], ['Audio is in the wrong language.', 'Use audio track selection in the player to choose another available track.']]],
  ['Playlist configuration', [['Does EliteStream include channels?', 'No. EliteStream is a media player. You add your own lawful content source, supplied by a provider you have rights with.'], ['Where do I add my source?', 'Content sources are added inside the app. Step‑by‑step guidance will be published with the release.']]],
  ['EPG configuration', [['The programme guide is empty.', 'Guide data comes from your content source or EPG provider. Confirm your source supplies EPG data and allow time for it to load.']]],
  ['AI functionality', [['Do AI features need the internet?', 'Yes. AI functionality may require an internet connection and an API provider, and requests may be processed by third parties.'], ['Does playback depend on AI?', 'No. Core playback works without AI features.']]],
  ['Contact support', [['How do I contact the team?', 'A dedicated support channel will open alongside the first public release and will be listed here.']]]
];

export const PRINCIPLES = [
  { num: '01', t: 'Usability', d: 'Every screen is designed for a remote control first, with clear focus states and short paths to content.' },
  { num: '02', t: 'Performance', d: 'Built to feel responsive on television hardware, where every millisecond is noticeable.' },
  { num: '03', t: 'Innovation', d: 'Thoughtful AI assistance, introduced openly and only when it genuinely helps.' }
];

export function platforms() {
  const st = (k) => (STATUS[k] ? k : 'In development');
  return [
    ['01', 'Samsung Smart TV', 'Tizen', 'Samsung', PROPS.tizenStatus],
    ['02', 'LG Smart TV', 'webOS', 'LG', PROPS.webosStatus],
    ['03', 'Philips', 'Android TV', 'Philips Android', PROPS.androidStatus],
    ['04', 'Philips', 'Titan OS', 'Philips Titan', PROPS.titanStatus]
  ].map(([num, brand, os, short, v]) => { const k = st(v); return { num, brand, os, short, status: k, cls: STATUS[k].cls, statusText: STATUS[k].t }; });
}

export function aiItems() {
  const k = STATUS[PROPS.aiStatus] ? PROPS.aiStatus : 'Planned';
  return AI.map(([name, desc], i) => ({ num: String(i + 1).padStart(2, '0'), name, desc, status: k, cls: STATUS[k].cls }));
}
