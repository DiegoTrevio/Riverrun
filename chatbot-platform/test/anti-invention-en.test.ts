import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FactCorpus } from '../src/engine/text.js';

/**
 * El asistente no inventa, también en inglés (negocios de Estados Unidos): precios, descuentos, promociones, regalos y
 * horas solo salen de la información del negocio o de lo que dijo el cliente. Mismos casos que anti-invention.test.ts,
 * escritos como los diría el asistente en inglés.
 */

const INFO = [
  'Double room: $165 per night. Check-in 3:00 PM and check-out 11:00 AM. Breakfast $15 per person.',
  'Promotion: buy one get one free on breakfast on Tuesdays. 10% off when paying cash. Free wifi for guests.',
  'Book at https://palmshotel.com/book or call (305) 555-0142.',
];
const NOW = 'Tuesday, October 20, 2026, 3:20 PM';
const HOURS = 'Monday: 09:00 to 18:00\nTuesday: 09:00 to 18:00';

function check(customer: string[], reply: string) {
  const business = [...INFO, NOW, HOURS];
  return new FactCorpus([...business, ...customer]).unverified(reply, new FactCorpus(business), new FactCorpus(customer));
}

test('en inglés: un porcentaje, una promoción o algo gratis que no está en la información no se da', () => {
  assert.deepEqual(check(['hi'], 'Today you get 5% off'), ['5%']);
  assert.deepEqual(check(['can I get 20%?'], 'Sure, we can give you 20 percent off'), ['20%'], 'el cliente no dicta un descuento');
  assert.deepEqual(check(['hi'], 'We have a buy two get one free deal on rooms'), ['3x2']);
  assert.equal(check(['hi'], 'Parking is free').length, 1, 'gratis, pero de algo que el negocio no regala');
  assert.equal(check(['hi'], 'Parking is complimentary').length, 1);
  assert.equal(check(['hi'], 'Dinner is on the house').length, 1);
  assert.equal(check(['hi'], "There's no charge for parking").length, 1);
  assert.equal(check(['hi'], 'We include parking at no cost').length, 1);
  assert.deepEqual(check(['hi'], 'It is one thousand five hundred dollars'), ['«one thousand five hundred dollars» (escribe la cantidad con cifras)']);
});

test('en inglés: ofertas legítimas, las de la información y las que la respuesta niega', () => {
  assert.deepEqual(check(['hi'], 'Paying cash you get 10% off'), []);
  assert.deepEqual(check(['hi'], 'On Tuesdays breakfast is buy one get one free'), []);
  assert.deepEqual(check(['hi'], 'Wifi is free for guests'), []);
  assert.deepEqual(check(['hi'], "It's free!"), [], 'sin decir qué: basta con que el negocio regale algo');
  assert.deepEqual(check(['do you have 3x2?'], "We don't offer 3x2, but on Tuesdays breakfast is buy one get one free"), []);
  assert.deepEqual(check(['can I get 20%?'], "We don't have that 20%, sorry"), []);
  assert.deepEqual(check(['is parking free?'], 'Parking is not free'), []);
  assert.deepEqual(check(['is parking free?'], "No, parking isn't free"), []);
  const business = ['Booking has no cost.'];
  assert.deepEqual(new FactCorpus(business).unverified('Booking is free of charge', new FactCorpus(business), new FactCorpus(['hi'])), []);
});

test('en inglés: horas, solo las del negocio o la que propuso el cliente', () => {
  assert.deepEqual(check(['what time do you open?'], "We're open from 7 to 9"), ['7:00 h'], 'el 9 sí es del horario; el 7 no');
  assert.deepEqual(check(['hi'], 'Check-in is at 2 PM'), ['2:00 h']);
  assert.deepEqual(check(['hi'], 'We open at 8 every day'), ['8:00 h']);
  assert.deepEqual(check(['what time do you open?'], "We're open 9 to 6"), [], 'de 9:00 a 18:00');
  assert.deepEqual(check(['what time do you open?'], 'We open at 9 and close at 6'), []);
  assert.deepEqual(check(['hi'], 'Check-in is at 3 PM and check-out at 11'), []);
  assert.deepEqual(check(['can you call me at 5:30?'], "Sure, we'll call you at 5:30"), [], 'la hora que propuso el cliente');
  assert.deepEqual(check(['hi'], "It's 3:20 PM right now"), [], 'la hora actual');
  assert.deepEqual(check(['hi'], 'Rooms for 2 to 4 people'), [], 'una cantidad, no un horario');
});

test('en inglés: cotización, el precio unitario va en la respuesta y la cantidad la dijo el cliente', () => {
  assert.deepEqual(check(['we are 2 adults, how much is the double?'], 'The double is $330 per night (2 adults)'), ['330']);
  assert.deepEqual(check(['how much is the double?'], 'For 2 nights it would be $330 ($165 per night)'), ['330'], 'el cliente no dijo 2 noches');
  assert.deepEqual(check(['it would be 2 nights'], '2 nights × $165 = $330'), []);
  assert.deepEqual(check(['from November 20 to 23'], "That's 3 nights: $165 × 3 = $495"), [], 'del 20 al 23 = 3 noches');
  assert.deepEqual(check(['there are two of us'], 'Breakfast is $15 per person: $30 for both of you'), [], 'la cantidad con palabras');
  assert.deepEqual(check(['2 adults and 1 child'], 'Breakfast: $15 × 3 = $45'), [], 'la suma de lo que dijo');
});

test('en inglés: dinero, otras formas de escribirlo y cifras de la fecha no validan un precio', () => {
  assert.deepEqual(check(['I have 1200'], "It's 1200 dollars"), ['1200'], 'el cliente no dicta el precio');
  assert.deepEqual(check(['I have 1200'], "That'd be 1200 bucks"), ['1200']);
  assert.deepEqual(check(['I have 1200'], 'It comes to 1,200 USD'), ['1200']);
  assert.deepEqual(check(['hi'], 'It costs 15 thousand dollars'), ['15000']);
  assert.deepEqual(check(['hi'], 'It costs $20'), ['20'], 'el 20 de la fecha no es un precio');
  assert.deepEqual(check(['hi'], 'It costs $2026'), ['2026'], 'ni el año');
  assert.deepEqual(check(['hi'], 'The double is $165 per night'), []);
  assert.deepEqual(check(['hi'], 'The double is 165 dollars a night'), []);
  assert.deepEqual(check(['hi'], 'Breakfast is 15 bucks per person'), []);
});

test('en inglés: cantidades con unidad, fechas y horas no son precios', () => {
  const business = ['Cabin: $250 per night. Max 6 people.'];
  const v = (reply: string, customer = ['hi']) => new FactCorpus([...business, ...customer]).unverified(reply, new FactCorpus(business), new FactCorpus(customer));
  assert.deepEqual(v('The cabin is $250 per night for up to 6 people'), []);
  assert.deepEqual(v('For 4 nights it would be $1,000 ($250 per night)', ['4 nights please']), []);
  assert.deepEqual(v('The cabin is $250 a night', ['we arrive on December 18, 2026']), []);
  assert.deepEqual(v('It costs $18', ['we arrive on December 18, 2026']), ['18'], 'el día de la fecha no es un precio');
});

test('en inglés: lo que parece negación pero ofrece algo sigue revisándose', () => {
  assert.deepEqual(check(['hi'], "Don't miss our 30% off this week"), ['30%'], '«don\'t miss» no niega la oferta');
  assert.equal(check(['hi'], "We don't charge for parking").length, 1, '«no cobramos» dice que es gratis');
  assert.equal(check(['hi'], 'Parking costs nothing').length, 1);
  assert.deepEqual(check(['hi'], 'Get it for 25 dollars today'), ['25']);
  assert.deepEqual(check(['hi'], 'Twenty percent off for you'), ['20%']);
  assert.deepEqual(check(['hi'], 'Buy 3, get 1 free on rooms this weekend'), ['4x3']);
  assert.deepEqual(check(['hi'], 'BOGO breakfast on Tuesdays'), [], 'BOGO = 2x1, el de la información');
  assert.deepEqual(check(['hi'], 'Breakfast is buy one get one free on Tuesdays'), [], 'la promoción de la información');
});

test('en inglés: un monto tapado nunca llega al cliente', async () => {
  const { MASKED_MONEY_RE } = await import('../src/engine/text.js');
  for (const s of ['It costs [price]', 'Total: {amount}', 'It is $XX per night']) assert.ok(MASKED_MONEY_RE.test(s), s);
});

test('en inglés: un «is not» o un «if you do not…» de otra parte de la oración no niega la oferta', () => {
  for (const reply of [
    'You get 20% off since we are not busy',
    'Get 20% off - isn\'t that great',
    'Get 30% off this isn\'t a joke',
    'Save 20% off as long as you are not late',
    'Get 20% off if you do not have a coupon',
  ]) assert.equal(check(['hi'], reply).length, 1, reply);
  for (const reply of ['Enjoy free parking since the hotel is not full', 'Free breakfast for guests who are not smokers', 'Free shuttle when you do not use the pool']) {
    assert.equal(check(['hi'], reply).length, 1, reply);
  }
});

test('en inglés: más formas de escribir una promoción', () => {
  assert.deepEqual(check(['hi'], 'Rooms are 2 for 1 this week'), [], '2 for 1 = 2x1, la de la información');
  assert.deepEqual(check(['hi'], 'Three for the price of two on rooms'), ['3x2']);
  assert.deepEqual(check(['hi'], 'Rooms are 3-for-2 today'), ['3x2']);
  assert.deepEqual(check(['hi'], 'Rooms are half price today'), ['50%']);
  assert.deepEqual(check(['we are 3'], 'A table for 3 for 2 hours'), [], 'una cantidad, no una promoción');
});
