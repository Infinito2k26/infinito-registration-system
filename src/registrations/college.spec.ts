import { collegeDisplayName, collegeNameKey } from './college';

describe('college grouping', () => {
  it('groups spelling variants that differ only in case and spacing', () => {
    for (const name of ['NIT Patna', ' nit  patna ', 'NIT\tPatna', 'Nit patna']) {
      expect(collegeNameKey(name)).toBe('nit patna');
    }
    expect(collegeDisplayName('  NIT   Patna ')).toBe('NIT Patna');
    expect(collegeNameKey('IIT Patna')).not.toBe(collegeNameKey('NIT Patna'));
  });
});
