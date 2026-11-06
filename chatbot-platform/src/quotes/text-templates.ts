/**
 * Plantillas por giro para el cotizador escrito: un texto de ejemplo, en palabras de un negocio, con precios de muestra.
 * El negocio elige la más parecida, cambia precios y reglas por los suyos y lo arma. No son calculadoras: son el texto
 * de partida (así cada cuenta se queda con un texto que entiende y puede editar).
 */
export interface QuoteTextTemplate {
  key: string;
  label: string;
  text: string;
}

export const QUOTE_TEXT_TEMPLATES: readonly QuoteTextTemplate[] = [
  {
    key: 'cercas',
    label: 'Cercas y mallas',
    text: `Para cotizar pide: metros lineales, modelo (Recta o Clásica), altura (1.50 o 2.00 m) y fijación (con placa o cimentado). Una pregunta a la vez.

Cantidades:
- Paneles: metros lineales entre 2.50, redondeado hacia arriba.
- Postes: paneles + 1. Con placa el poste mide lo mismo que la altura; cimentado mide la altura + 0.50 m.
- Placas: una por poste, solo si es con placa.
- Abrazaderas: postes × 3 si la altura es 1.50 m; postes × 4 si es 2.00 m.

Escalones según los metros: A menos de 15; B de 15 a menos de 50; C de 50 a menos de 100. De 100 metros o más lo atiende un asesor.

Precios (más IVA):
Panel Recta 1.50 m: A $700, B $660, C $630
Panel Recta 2.00 m: A $890, B $850, C $810
Panel Clásica 1.50 m: A $820, B $780, C $740
Panel Clásica 2.00 m: A $1,050, B $1,000, C $950
Poste 1.50 m: A $360, B $340, C $320
Poste 2.00 m: A $420, B $400, C $380
Poste 2.50 m: A $470, B $450, C $430
Placa: A $90, B $80, C $75
Abrazadera: A $14, B $12, C $11

Instalación solo si el cliente la pide: con placa $420 por metro; cimentada $600 por metro. Más de 50 metros de instalación lo ve un asesor.
Aclara que el precio es aproximado y sujeto a visita. Vigencia 15 días.`,
  },
  {
    key: 'superficies',
    label: 'Pintura por m²',
    text: `Pintura e impermeabilización por metro cuadrado.
Para cotizar pide: largo y ancho del área (en metros) y el servicio (pintura vinílica, pintura esmalte o impermeabilizante).
Área = largo × ancho, a dos decimales.
Material: pintura vinílica rinde 10 m² por litro; esmalte 8 m² por litro; impermeabilizante 1 litro por m². Los litros se redondean hacia arriba.

Precios por litro (más IVA), con escalón según el área: menudeo menos de 100 m², mayoreo desde 100 m².
- Vinílica: menudeo $95, mayoreo $85
- Esmalte: menudeo $140, mayoreo $125
- Impermeabilizante: menudeo $65, mayoreo $58

Mano de obra por m²: pintura $38, impermeabilizante $45.
Más de 1,000 m² lo cotiza un asesor después de una visita.
Cotización aproximada, vigencia 10 días.`,
  },
  {
    key: 'eventos',
    label: 'Salón y eventos',
    text: `Salón de eventos. Para cotizar pide: número de invitados (mínimo 50), paquete (Plata u Oro) y el día (viernes, sábado o domingo).
Precio por persona: Plata $450, Oro $620. Los sábados el precio por persona sube $50.
Renta del salón: $8,000 viernes o domingo; $12,000 sábado.
Mesas: una por cada 10 invitados, hacia arriba; mantelería $35 por mesa.
Extras solo si los pide: DJ $6,500; barra libre $180 por persona.
Más de 400 invitados lo ve un asesor. Los precios ya incluyen IVA.`,
  },
  {
    key: 'servicios',
    label: 'Servicios por hora',
    text: `Servicio técnico a domicilio. Para cotizar pide: tipo de servicio (electricidad, plomería o aire acondicionado), horas estimadas y la zona (centro o foránea).
Precio por hora (más IVA): electricidad $380, plomería $350, aire acondicionado $480. Se cobra un mínimo de 2 horas y las horas se redondean hacia arriba.
Visita: centro sin costo; foránea $250.
Material aparte: no se cotiza aquí.
Trabajos de más de 16 horas los cotiza un técnico en persona.`,
  },
  {
    key: 'mayoreo',
    label: 'Productos con mayoreo',
    text: `Playeras personalizadas. Para cotizar pide: cantidad de piezas, modelo (algodón o dry-fit) y si lleva estampado (sí o no).
Precio por pieza (más IVA) según la cantidad:
- Algodón: 1 a 11 piezas $180; 12 a 99 piezas $150; 100 o más $120.
- Dry-fit: 1 a 11 piezas $220; 12 a 99 piezas $185; 100 o más $150.
Estampado: $45 por pieza, solo si lo pide.
Pedidos de 1,000 piezas o más los atiende un asesor.`,
  },
  {
    key: 'renta',
    label: 'Renta por días',
    text: `Renta de mobiliario para eventos. Para cotizar pide: número de sillas, número de mesas y cuántos días.
Precio por pieza por día (más IVA): silla $18, mesa $85. Desde el tercer día cada día extra cuesta la mitad.
Entrega y recolección: $450 por pedido.
Mínimo 20 sillas. Más de 1,000 sillas lo ve un asesor.`,
  },
];
