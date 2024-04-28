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
    { name: 'Paul Stephenson III' },
    { name: 'Mehmet' },
    { name: 'Michael Lejeune' },
    { name: 'Josh Stephens' },
    { name: 'Boz' },
    { name: 'Francisco Lopez' },
    { name: 'Ellie VanBerkel' },
    { name: 'Robby Badruddin' },
    { name: 'Grayerbeard' },
    { name: 'Jose' },
    { name: 'EVALDO JESUS' },
    { name: 'Nate Dude' },
    { name: 'Jochen' },
    { name: 'J Trent' },
    { name: 'Jiri Rose' },
    { name: 'Pavel Eliminiro' },
    { name: 'Charles Bronitsky' },
    { name: 'Sashi' },
    { name: 'Darren Taylor' },
    { name: 'Sebastian Kost' },
    { name: 'C.A. Hall' },
    { name: 'Richard Bennett' },
    { name: 'Neil' },
    { name: 'James Traver' },
    { name: 'Alex Yao' },
    { name: 'x lotusinthemud x' },
    { name: 'Stefan Wagner' },
    { name: 'BuzzSenior' },
    { name: 'Jeff Kiefer' },
  ] as Supporter[],

  youtubeMembers: [
    {
      name: 'Sebastian Kost',
    },
  ] as Supporter[],
};
