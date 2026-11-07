import { isRestrictedVehicle } from './restricted-vehicles';

describe('isRestrictedVehicle', () => {
  it('matches all five plates in any spacing, case or separator', () => {
    for (const plate of [
      'KL85B1418',
      'KL 85 B 6934',
      'kl85b3285',
      'KL-85-B-3218',
      ' KL 85 B 4876 ',
    ]) {
      expect(isRestrictedVehicle(plate)).toBe(true);
    }
  });

  it('leaves every other vehicle alone', () => {
    for (const plate of [
      'KL85B7233',
      'KL85B14180',
      'KL85B141',
      'KL07CD4521',
      '',
      null,
      undefined,
    ]) {
      expect(isRestrictedVehicle(plate)).toBe(false);
    }
  });
});
