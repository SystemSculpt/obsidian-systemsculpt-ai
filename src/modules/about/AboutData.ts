export interface Supporter {
  name: string;
  coffees?: number; // Optional property if some supporters might have this
}

export const AboutData = {
  buyMeACoffee: [
    {
      name: 'Ronny Khalil',
      coffees: 1,
    },
  ] as Supporter[],
  patreonMembers: [
    { name: 'Bone74' },
    { name: 'J Trent' },
    { name: 'x lotusinthemud x' },
    { name: 'Samuel B.' },
    { name: 'Sebastian Kost' },
    { name: 'Sashi' },
    { name: 'Jose' },
    { name: 'BuzzSenior' },
    { name: 'Wilinusa' },
    { name: 'James Stratton-Crawley' },
    { name: 'Michael Lejeune' },
    { name: 'Stefan Wagner' },
    { name: 'Jiri Rose' },
    { name: 'Ellie VanBerkel' },
    { name: 'Boz' },
    { name: 'Francisco Lopez' },
    { name: 'Jennifer & Adam Davis' },
    { name: 'Richard Bennett' },
    { name: 'Josh Stephens' },
    { name: 'Charles Bronitsky' },
    { name: 'Robby Badruddin' },
    { name: 'Grayerbeard' },
    { name: 'Jeff Kiefer' },
    { name: 'Jochen' },
    { name: 'Gerald Anderson' },
    { name: 'Mehmet' },
    { name: 'Paul Stephenson III' },
  ] as Supporter[],

  youtubeMembers: [
    {
      name: 'Sebastian Kost',
    },
  ] as Supporter[],
};
