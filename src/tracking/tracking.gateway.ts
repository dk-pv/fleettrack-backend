import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
} from '@nestjs/websockets';

import { Server } from 'socket.io';


@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class TrackingGateway
  implements OnGatewayInit
{
  @WebSocketServer()
  server!: Server;

  afterInit() {
    console.log(
      'Tracking WebSocket Gateway Initialized',
    );
  }
}
