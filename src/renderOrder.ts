/** Render work may lag the clock, but may never replace a newer painted result. */
export class RenderOrder {
  private generation=0;private painted=0;
  capture(){return {generation:this.generation,painted:this.painted};}
  accepts(ticket:{generation:number;painted:number}){return ticket.generation===this.generation&&ticket.painted===this.painted;}
  didPaint(){this.painted++;}
  invalidate(){this.generation++;}
}
