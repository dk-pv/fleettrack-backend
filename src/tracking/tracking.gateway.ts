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

    this.startMockTracking();
  }

  startMockTracking() {
    setInterval(() => {
      const mockVehicle = {
        id: 'demo-vehicle',

        latitude:
          8.5241 +
          (Math.random() - 0.5) *
            0.01,

        longitude:
          76.9366 +
          (Math.random() - 0.5) *
            0.01,

        speed: Math.floor(
          Math.random() * 80,
        ),

        updatedAt:
          new Date().toISOString(),
      };

      this.server.emit(
        'vehicleLocationUpdate',
        mockVehicle,
      );
    }, 5000);
  }
}
